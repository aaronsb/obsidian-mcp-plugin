import { ObsidianAPI } from '../utils/obsidian-api';
import {
  SemanticResponse,
  WorkflowConfig,
  SemanticContext,
  SemanticRequest,
  SuggestedAction,
  ConditionalSuggestions,
  EfficiencyRule
} from '../types/semantic';
import { ContentBufferManager } from '../utils/content-buffer';
import { FileLockManager } from '../utils/file-lock';
import { StateTokenManager } from './state-tokens';
import { limitResponse } from '../utils/response-limiter';
import { isImageFile } from '../types/obsidian';
import { UniversalFragmentRetriever } from '../indexing/fragment-retriever';
import { GraphSearchTool, GraphSearchParams } from '../tools/graph-search';
import { GraphSearchTool as GraphSearchTraversalTool } from '../tools/graph-search-tool';
import { GraphTagTool } from '../tools/graph-tag-tool';
import { App } from 'obsidian';
import { InputValidator } from '../validation/input-validator';
import { BaseYAML } from '../types/bases-yaml';
import { RouterContext } from './operations/router-context';
import { executeVaultOperation } from './operations/vault';
import { Params, SearchResultItem, paramStr, paramNum, paramBool, requireParamStr } from './operations/shared';

export class SemanticRouter implements RouterContext {
  private config!: WorkflowConfig;
  private context: SemanticContext = {};
  // Public to satisfy RouterContext — the router passes itself as the
  // dependency context to extracted operation modules (ADR-202, #199).
  readonly api: ObsidianAPI;
  private tokenManager: StateTokenManager;
  readonly fragmentRetriever: UniversalFragmentRetriever;
  private graphSearchTool?: GraphSearchTool;
  private graphSearchTraversalTool?: GraphSearchTraversalTool;
  private graphTagTool?: GraphTagTool;
  readonly app?: App;
  readonly validator: InputValidator;

  constructor(api: ObsidianAPI, app?: App) {
    this.api = api;
    this.app = app;
    this.tokenManager = new StateTokenManager();
    this.fragmentRetriever = new UniversalFragmentRetriever();
    this.validator = new InputValidator();
    if (app) {
      this.graphSearchTool = new GraphSearchTool(api, app);
      this.graphSearchTraversalTool = new GraphSearchTraversalTool(app, api);
      this.graphTagTool = new GraphTagTool(app, api);
    }
    this.loadConfig();
  }
  
  private loadConfig() {
    // Use default configuration - in the future this could be loaded from Obsidian plugin settings
    this.config = this.getDefaultConfig();
  }
  
  private getDefaultConfig(): WorkflowConfig {
    return {
      version: '1.0.0',
      description: 'Default workflow configuration',
      operations: {
        vault: {
          description: 'File operations',
          actions: {}
        },
        edit: {
          description: 'Edit operations', 
          actions: {}
        }
      }
    };
  }
  
  /**
   * Route a semantic request to the appropriate handler and enrich the response
   */
  async route(request: SemanticRequest): Promise<SemanticResponse> {
    const { operation, action, params } = request;
    
    // Update context
    this.updateContext(operation, action, params);
    
    try {
      // Execute the actual operation
      const result = await this.executeOperation(operation, action, params);
      
      // Update tokens based on success
      this.tokenManager.updateTokens(operation, action, params, result, true);
      
      // Enrich with semantic hints
      const response = this.enrichResponse(result, operation, action, params, false);
      
      // Update context with successful result
      this.updateContextAfterSuccess(response, params);
      
      return response;
      
    } catch (error: unknown) {
      // Update tokens for failure
      this.tokenManager.updateTokens(operation, action, params, null, false);
      
      // Handle errors with semantic recovery hints
      return this.handleError(error, operation, action, params);
    }
  }
  
  private async executeOperation(operation: string, action: string, params: Params): Promise<unknown> {
    // Map semantic operations to actual tool calls
    switch (operation) {
      case 'vault':
        return executeVaultOperation(this, action, params);
      case 'edit':
        return this.executeEditOperation(action, params);
      case 'view':
        return this.executeViewOperation(action, params);
      case 'workflow':
        return this.executeWorkflowOperation(action, params);
      case 'system':
        return this.executeSystemOperation(action, params);
      case 'graph':
        return this.executeGraphOperation(action, params);
      case 'bases':
        return this.executeBasesOperation(action, params);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
  
  private async executeEditOperation(action: string, params: Params): Promise<unknown> {
    const buffer = ContentBufferManager.getInstance();

    // Serialize all edit actions targeting the same file so parallel
    // edit.window/append/patch/at_line/from_buffer calls from a batched MCP
    // client can no longer silently clobber each other (#139). Different
    // files remain fully concurrent.
    // Guard the lock key up-front so a missing path can't take a lock on
    // the literal string "undefined" and serialize unrelated bad calls.
    const lockPath = requireParamStr(params, 'path', `edit.${action}`);
    return FileLockManager.getInstance().withLock(lockPath, async () => {
    switch (action) {
      case 'window': {
        const oldText = requireParamStr(params, 'oldText', 'edit.window');
        const newText = requireParamStr(params, 'newText', 'edit.window');
        // Imported dynamically (only when needed) to avoid circular deps.
        const { performWindowEdit } = await import('../tools/window-edit.js');
        const result = await performWindowEdit(
          this.api,
          lockPath,
          oldText,
          newText,
          paramNum(params, 'fuzzyThreshold')
        );
        if (result.isError) {
          throw new Error(result.content[0].text);
        }
        return result;
      }
      case 'append': {
        const content = requireParamStr(
          params,
          'content',
          'edit.append',
          "Pass the text to append as 'content'.",
        );
        return await this.api.appendToFile(lockPath, content);
      }
      case 'patch':
        return await this.api.patchVaultFile(lockPath, {
          operation: paramStr(params, 'operation'),
          targetType: paramStr(params, 'targetType'),
          target: paramStr(params, 'target'),
          content: paramStr(params, 'content'),
          old_text: paramStr(params, 'oldText'),
          new_text: paramStr(params, 'newText')
        });
      case 'at_line': {
        // Get content to insert
        let insertContent = paramStr(params, 'content');
        if (!insertContent) {
          const buffered = buffer.retrieve();
          if (!buffered) {
            throw new Error('No content provided and no buffered content found');
          }
          insertContent = buffered.content;
        }

        // Get file and perform line-based edit
        const filePath = lockPath;
        const file = await this.api.getFile(filePath);
        if (isImageFile(file)) {
          throw new Error('Cannot perform line-based edits on image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');
        const lineNumber = paramNum(params, 'lineNumber') ?? 1;

        if (lineNumber < 1 || lineNumber > lines.length + 1) {
          throw new Error(`Invalid line number ${lineNumber}. File has ${lines.length} lines.`);
        }

        const lineIndex = lineNumber - 1;
        const mode = paramStr(params, 'mode') || 'replace';

        switch (mode) {
          case 'before':
            lines.splice(lineIndex, 0, insertContent);
            break;
          case 'after':
            lines.splice(lineIndex + 1, 0, insertContent);
            break;
          case 'replace':
            lines[lineIndex] = insertContent;
            break;
        }

        await this.api.updateFile(filePath, lines.join('\n'));
        return { success: true, line: lineNumber, mode };
      }
      case 'from_buffer': {
        const buffered = buffer.retrieve();
        if (!buffered) {
          throw new Error('No buffered content available');
        }
        const { performWindowEdit } = await import('../tools/window-edit.js');
        return await performWindowEdit(
          this.api,
          lockPath,
          paramStr(params, 'oldText') || buffered.searchText || '',
          buffered.content,
          paramNum(params, 'fuzzyThreshold')
        );
      }
      default:
        throw new Error(`Unknown edit action: ${action}`);
    }
    });
  }

  private async executeViewOperation(action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'file':
        return await this.api.getFile(requireParamStr(params, 'path', 'view.file'));
      case 'window': {
        // View a portion of a file
        const viewPath = requireParamStr(params, 'path', 'view.window');
        const file = await this.api.getFile(viewPath);
        if (isImageFile(file)) {
          throw new Error('Cannot view window of image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');
        const searchText = paramStr(params, 'searchText');

        let centerLine = paramNum(params, 'lineNumber') || 1;

        // If search text provided, find it
        if (searchText && !params.lineNumber) {
          const { findFuzzyMatches } = await import('../utils/fuzzy-match.js');
          const matches = findFuzzyMatches(content, searchText, 0.6);
          if (matches.length > 0) {
            centerLine = matches[0].lineNumber;
          }
        }

        // Calculate window
        const windowSize = paramNum(params, 'windowSize') || 20;
        const halfWindow = Math.floor(windowSize / 2);
        const startLine = Math.max(1, centerLine - halfWindow);
        const endLine = Math.min(lines.length, centerLine + halfWindow);

        return {
          path: viewPath,
          lines: lines.slice(startLine - 1, endLine),
          startLine,
          endLine,
          totalLines: lines.length,
          centerLine,
          searchText
        };
      }
        
      case 'active':
        // Add timeout to prevent hanging when no file is active
        try {
          const timeoutPromise = new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error('Timeout: No active file in Obsidian. Please open a file first.')), 5000)
          );
          const activeResult = await Promise.race([
            this.api.getActiveFile(),
            timeoutPromise
          ]);
          return activeResult;
        } catch (error: unknown) {
          if (error instanceof Error && error.message?.includes('Timeout')) {
            throw error;
          }
          // Re-throw original error if not timeout
          throw error;
        }
        
      case 'open_in_obsidian':
        return await this.api.openFile(requireParamStr(params, 'path', 'view.open_in_obsidian'));
        
      default:
        throw new Error(`Unknown view action: ${action}`);
    }
  }
  
  private executeWorkflowOperation(action: string, _params: Params): unknown {
    switch (action) {
      case 'suggest':
        return this.generateWorkflowSuggestions();
      default:
        throw new Error(`Unknown workflow action: ${action}`);
    }
  }
  
  private async executeSystemOperation(action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'info':
        return this.api.getServerInfo();
      case 'commands':
        return this.api.getCommands();
      case 'fetch_web': {
        // Import fetch tool dynamically
        const { fetchTool } = await import('../tools/fetch.js');
        return await (fetchTool.handler as unknown as (api: unknown, args: Params) => Promise<unknown>)(this.api, params);
      }
      default:
        throw new Error(`Unknown system action: ${action}`);
    }
  }
  
  private async executeGraphOperation(action: string, params: Params): Promise<unknown> {
    // Handle graph search traversal operations
    if (action === 'search-traverse' || action === 'advanced-traverse') {
      if (!this.graphSearchTraversalTool) {
        throw new Error('Graph search traversal operations require Obsidian app context');
      }
      return await this.graphSearchTraversalTool.execute({
        action,
        startPath: paramStr(params, 'startPath') ?? '',
        searchQuery: paramStr(params, 'searchQuery'),
        searchQueries: params.searchQueries as string[] | undefined,
        maxDepth: paramNum(params, 'maxDepth'),
        maxSnippetsPerNode: paramNum(params, 'maxSnippetsPerNode'),
        scoreThreshold: paramNum(params, 'scoreThreshold'),
        strategy: paramStr(params, 'strategy') as 'breadth-first' | 'best-first' | 'beam-search' | undefined,
        beamWidth: paramNum(params, 'beamWidth'),
        includeOrphans: paramBool(params, 'includeOrphans'),
        followTags: paramBool(params, 'followTags'),
        filePattern: paramStr(params, 'filePattern')
      });
    }

    // Handle tag-based graph operations
    if (action === 'tag-traverse' || action === 'tag-analysis' || action === 'shared-tags') {
      if (!this.graphTagTool) {
        throw new Error('Graph tag operations require Obsidian app context');
      }
      return await this.graphTagTool.execute({
        action,
        startPath: paramStr(params, 'startPath'),
        targetPath: paramStr(params, 'targetPath'),
        searchQuery: paramStr(params, 'searchQuery'),
        maxDepth: paramNum(params, 'maxDepth'),
        maxSnippetsPerNode: paramNum(params, 'maxSnippetsPerNode'),
        scoreThreshold: paramNum(params, 'scoreThreshold'),
        followTags: paramBool(params, 'followTags'),
        tagWeight: paramNum(params, 'tagWeight')
      });
    }

    // Handle standard graph operations
    if (!this.graphSearchTool) {
      throw new Error('Graph operations require Obsidian app context');
    }

    // Map action to graph operation
    const graphParams: GraphSearchParams = {
      operation: action as GraphSearchParams['operation'],
      sourcePath: paramStr(params, 'sourcePath'),
      targetPath: paramStr(params, 'targetPath'),
      maxDepth: paramNum(params, 'maxDepth'),
      maxNodes: paramNum(params, 'maxNodes'),
      includeUnresolved: paramBool(params, 'includeUnresolved'),
      followBacklinks: paramBool(params, 'followBacklinks'),
      followForwardLinks: paramBool(params, 'followForwardLinks'),
      followTags: paramBool(params, 'followTags'),
      fileFilter: paramStr(params, 'fileFilter'),
      tagFilter: params.tagFilter as string[] | undefined,
      folderFilter: paramStr(params, 'folderFilter')
    };

    return this.graphSearchTool.search(graphParams);
  }
  
  private enrichResponse(result: unknown, operation: string, action: string, params: Params, isError: boolean): SemanticResponse {
    const operationConfig = this.config?.operations?.[operation];
    const actionConfig = operationConfig?.actions?.[action];
    
    // Skip limiting for vault read operations and view file operations - we want the full document/image
    const shouldLimit = !(operation === 'vault' && action === 'read') && 
                       !(operation === 'view' && action === 'file');
    
    // Limit the result size to prevent token overflow (except for vault reads)
    const limitedResult = shouldLimit ? limitResponse(result) : result;
    
    const response: SemanticResponse = {
      result: limitedResult,
      context: this.getCurrentContext()
    };
    
    // Add workflow hints
    if (actionConfig) {
      const hints = isError ? actionConfig.failure_hints : actionConfig.success_hints;
      if (hints && hints.suggested_next) {
        response.workflow = {
          message: this.interpolateMessage(hints.message || '', params, result),
          suggested_next: this.generateSuggestions(hints.suggested_next, params, result)
        };
      }
    }
    
    // Add enhanced semantic hints for search and other operations to encourage graph exploration
    if (!isError) {
      const enhancedHints = this.generateEnhancedSemanticHints(operation, action, params, result);
      if (enhancedHints && enhancedHints.suggested_next.length > 0) {
        if (response.workflow) {
          // Merge with existing workflow hints
          response.workflow.suggested_next = [
            ...response.workflow.suggested_next,
            ...enhancedHints.suggested_next
          ];
          response.workflow.message += ' ' + enhancedHints.message;
        } else {
          response.workflow = enhancedHints;
        }
      }
    }
    
    // Add efficiency hints
    const efficiencyHints = this.checkEfficiencyRules(operation, action, params);
    if (efficiencyHints.length > 0) {
      response.efficiency_hints = {
        message: efficiencyHints[0].hint,
        alternatives: efficiencyHints.slice(1).map(h => h.hint)
      };
    }
    
    return response;
  }
  
  private interpolateMessage(template: string, params: Params, result: unknown): string {
    const resultRecord = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
    return template.replace(/{(\w+)}/g, (match, key: string) => {
      const paramVal = params[key];
      const resultVal = resultRecord[key];
      if (typeof paramVal === 'string') return paramVal;
      if (typeof resultVal === 'string') return resultVal;
      return match;
    });
  }
  
  private generateSuggestions(conditionalSuggestions: ConditionalSuggestions[], params: Params, result: unknown): SuggestedAction[] {
    const suggestions: SuggestedAction[] = [];
    
    if (!Array.isArray(conditionalSuggestions)) {
      return suggestions;
    }
    
    for (const conditional of conditionalSuggestions) {
      if (this.evaluateCondition(conditional.condition, params, result)) {
        for (const suggestion of conditional.suggestions || []) {
          // Check if required tokens are available
          if (suggestion.requires_tokens && !this.tokenManager.hasTokensFor(suggestion.requires_tokens)) {
            continue; // Skip this suggestion - required tokens not available
          }
          
          suggestions.push({
            description: suggestion.description,
            command: this.interpolateMessage(suggestion.command, params, result),
            reason: suggestion.reason
          });
        }
      }
    }
    
    return suggestions;
  }
  
  private evaluateCondition(condition: string, params: Params, result: unknown): boolean {
    const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : null;
    switch (condition) {
      case 'always':
        return true;
      case 'has_results': {
        if (!resultObj) return false;
        const results = resultObj.results;
        const totalResults = resultObj.totalResults;
        return (Array.isArray(results) && results.length > 0) || (typeof totalResults === 'number' && totalResults > 0);
      }
      case 'no_results': {
        if (!resultObj) return true;
        const results = resultObj.results;
        const totalResults = resultObj.totalResults;
        return (!Array.isArray(results) || results.length === 0) && (!totalResults || totalResults === 0);
      }
      case 'has_links': {
        if (!resultObj) return false;
        const links = resultObj.links;
        return Array.isArray(links) && links.length > 0;
      }
      case 'has_tags': {
        if (!resultObj) return false;
        const tags = resultObj.tags;
        return Array.isArray(tags) && tags.length > 0;
      }
      case 'has_markdown_files':
        return Array.isArray(result) && result.some(f => typeof f === 'string' && f.endsWith('.md'));
      case 'is_daily_note': {
        const pathVal = paramStr(params, 'path');
        if (!pathVal) return false;

        // Try to read the configured Daily Notes folder from Obsidian's internal plugin
        const dailyNotesFolder = this.getDailyNotesFolder();
        if (dailyNotesFolder) {
          return pathVal.startsWith(dailyNotesFolder + '/') || pathVal === dailyNotesFolder;
        }

        // Fall back to regex pattern heuristic
        return this.matchesPattern(pathVal, this.config.context_triggers?.daily_note_pattern);
      }
      default:
        return false;
    }
  }
  
  /**
   * Get the configured Daily Notes folder from Obsidian's internal plugin.
   * Returns undefined if the plugin is not enabled or no folder is configured.
   */
  private getDailyNotesFolder(): string | undefined {
    if (!this.app) return undefined;
    try {
      const internalPlugins = (this.app as unknown as Record<string, unknown>).internalPlugins as
        { getPluginById(id: string): { enabled: boolean; instance?: { options?: { folder?: string } } } | null } | undefined;
      if (!internalPlugins) return undefined;

      const dailyNotes = internalPlugins.getPluginById('daily-notes');
      if (dailyNotes?.enabled && dailyNotes.instance?.options?.folder) {
        return dailyNotes.instance.options.folder;
      }
    } catch {
      // Internal plugin API not available — fall back to pattern
    }
    return undefined;
  }

  private matchesPattern(value: string, pattern?: string): boolean {
    if (!pattern) return false;
    try {
      const regex = new RegExp(pattern, 'i');
      return regex.test(value);
    } catch {
      return false;
    }
  }
  
  private checkEfficiencyRules(operation: string, action: string, params: Params): EfficiencyRule[] {
    if (!this.config.efficiency_rules) return [];

    const matches: EfficiencyRule[] = [];
    for (const rule of this.config.efficiency_rules) {
      // Simple pattern matching for now
      if (rule.pattern === 'multiple_edits_same_file' && 
          this.context.last_file === params.path &&
          operation === 'edit') {
        matches.push(rule);
      }
    }
    
    return matches;
  }
  
  private updateContext(operation: string, action: string, params: Params) {
    this.context.operation = operation;
    this.context.action = action;
    const pathVal = paramStr(params, 'path');

    if (pathVal) {
      this.context.last_file = pathVal;
      
      // Track file history
      if (!this.context.file_history) {
        this.context.file_history = [];
      }
      if (!this.context.file_history.includes(pathVal)) {
        this.context.file_history.push(pathVal);
        // Keep only last 10 files
        if (this.context.file_history.length > 10) {
          this.context.file_history.shift();
        }
      }
    }
    
    const dirVal = paramStr(params, 'directory');
    if (dirVal) {
      this.context.last_directory = dirVal;
    }

    const queryVal = paramStr(params, 'query');
    if (queryVal) {
      if (!this.context.search_history) {
        this.context.search_history = [];
      }
      this.context.search_history.push(queryVal);
      // Keep only last 5 searches
      if (this.context.search_history.length > 5) {
        this.context.search_history.shift();
      }
    }
  }
  
  private updateContextAfterSuccess(response: SemanticResponse, _params: Params) {
    // Update buffer status
    const buffer = ContentBufferManager.getInstance();
    this.context.buffer_content = buffer.retrieve()?.content;
    
    // Update context based on the operation
    const tokens = this.tokenManager.getTokens();
    
    if (tokens.file_loaded) {
      this.context.last_file = tokens.file_loaded;
      this.context.file_history = tokens.file_history;
    }
    
    if (tokens.directory_listed) {
      this.context.last_directory = tokens.directory_listed;
    }
    
    if (tokens.search_query) {
      if (!this.context.search_history) {
        this.context.search_history = [];
      }
      if (!this.context.search_history.includes(tokens.search_query)) {
        this.context.search_history.push(tokens.search_query);
      }
    }
  }
  
  private getCurrentContext() {
    const tokens = this.tokenManager.getTokens();
    
    return {
      current_file: this.context.last_file,
      current_directory: this.context.last_directory,
      buffer_available: !!this.context.buffer_content,
      file_history: this.context.file_history,
      search_history: this.context.search_history,
      // Include relevant token states
      has_file_content: tokens.file_content,
      has_links: (tokens.file_has_links?.length ?? 0) > 0,
      has_tags: (tokens.file_has_tags?.length ?? 0) > 0,
      search_results_available: tokens.search_has_results,
      linked_files: tokens.file_has_links,
      tags: tokens.file_has_tags
    };
  }
  
  private handleError(error: unknown, operation: string, action: string, params: Params): SemanticResponse {
    const errorResponse = this.enrichResponse(
      null,
      operation,
      action,
      params,
      true // isError
    );

    // Extract parent directory from the directory parameter for suggestions
    const dirParam = paramStr(params, 'directory');
    if (operation === 'vault' && action === 'list' && dirParam) {
      const parts = dirParam.split('/');
      if (parts.length > 1) {
        parts.pop();
        params.parent_directory = parts.join('/') || undefined;
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error && typeof error === 'object' && 'code' in error) ? String((error as Record<string, unknown>).code) : undefined;
    errorResponse.error = {
      code: errorCode || 'UNKNOWN_ERROR',
      message: errorMessage,
      recovery_hints: errorResponse.workflow?.suggested_next
    };
    
    delete errorResponse.workflow; // Move suggestions to recovery_hints
    
    return errorResponse;
  }
  
  private generateWorkflowSuggestions(): { current_context: ReturnType<SemanticRouter['getCurrentContext']>; suggestions: SuggestedAction[] } {
    // Generate contextual workflow suggestions based on current state
    const suggestions: SuggestedAction[] = [];
    
    if (this.context.last_file) {
      suggestions.push({
        description: 'Continue working with last file',
        command: `vault(action='read', path='${this.context.last_file}')`,
        reason: 'Return to previous work'
      });
    }
    
    if (this.context.search_history?.length) {
      const lastSearch = this.context.search_history[this.context.search_history.length - 1];
      suggestions.push({
        description: 'Refine last search',
        command: `vault(action='search', query='${lastSearch} AND ...')`,
        reason: 'Narrow down results'
      });
    }
    
    // Always include a default suggestion if no context-specific ones
    if (suggestions.length === 0) {
      suggestions.push({
        description: 'Use workflow hints from other operations',
        command: 'vault(action="list") or vault(action="read", path="...") etc.',
        reason: 'Each operation provides contextual workflow suggestions'
      });
    }
    
    return {
      current_context: this.getCurrentContext(),
      suggestions
    };
  }

  /**
   * Generate enhanced semantic hints that encourage graph exploration over simple search
   */
  private generateEnhancedSemanticHints(operation: string, action: string, params: Params, result: unknown): { message: string; suggested_next: SuggestedAction[] } | null {
    const suggestions: SuggestedAction[] = [];
    let message = '';

    const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : null;

    // Enhanced hints for search operations
    if (operation === 'vault' && action === 'search') {
      const searchResults = resultObj?.results;
      if (searchResults && Array.isArray(searchResults) && searchResults.length > 0) {
        message = 'Consider exploring connections between these files using graph operations.';

        // Get first few results for graph exploration suggestions
        const firstResult = searchResults[0] as SearchResultItem | undefined;
        const hasMultipleResults = searchResults.length > 1;

        if (firstResult?.path) {
          suggestions.push({
            description: 'Explore connections from first result',
            command: `graph(action='traverse', sourcePath='${firstResult.path}', maxDepth=2)`,
            reason: 'Discover related files through links and references'
          });

          suggestions.push({
            description: 'Find files linking to this result',
            command: `graph(action='backlinks', sourcePath='${firstResult.path}')`,
            reason: 'See what files reference this content'
          });

          suggestions.push({
            description: 'Find files linked from this result',
            command: `graph(action='forwardlinks', sourcePath='${firstResult.path}')`,
            reason: 'See what this file references'
          });
        }

        if (hasMultipleResults) {
          const secondResult = searchResults[1] as SearchResultItem | undefined;
          if (secondResult?.path && firstResult?.path) {
            suggestions.push({
              description: 'Find connection path between top results',
              command: `graph(action='path', sourcePath='${firstResult.path}', targetPath='${secondResult.path}')`,
              reason: 'Discover how these search results are connected'
            });
          }
        }

        // Tag-based exploration if we detect potential tag-related content
        const queryParam = paramStr(params, 'query');
        if (queryParam && queryParam.includes('#')) {
          const tagQuery = queryParam.replace('#', '');
          suggestions.push({
            description: 'Explore files with similar tags',
            command: `graph(action='tag-analysis', tagFilter=['${tagQuery}'])`,
            reason: 'Find files grouped by similar tags'
          });
        }
      }
    }

    // Enhanced hints for read operations - suggest exploring connections
    if (operation === 'vault' && action === 'read') {
      const readPath = paramStr(params, 'path');
      const hasError = resultObj ? 'error' in resultObj : false;
      if (readPath && !hasError) {
        message = 'Explore connections and references for deeper context.';

        suggestions.push({
          description: 'Explore graph connections from this file',
          command: `graph(action='neighbors', sourcePath='${readPath}')`,
          reason: 'Find directly connected files'
        });

        suggestions.push({
          description: 'Find files that reference this one',
          command: `graph(action='backlinks', sourcePath='${readPath}')`,
          reason: 'See where this file is mentioned or linked'
        });

        // Check if the content suggests it might have many connections
        const rawContent = typeof result === 'string' ? result : (resultObj?.content ?? '');

        // Safely count links and tags, handling both string content and Fragment arrays
        let linkCount = 0;
        let tagCount = 0;

        if (typeof rawContent === 'string') {
          linkCount = (rawContent.match(/\[\[.*?\]\]/g) || []).length;
          tagCount = (rawContent.match(/#\w+/g) || []).length;
        } else if (Array.isArray(rawContent)) {
          // Handle Fragment[] - extract content from each fragment
          for (const fragment of rawContent) {
            let fragmentText = '';
            if (typeof fragment === 'string') {
              fragmentText = fragment;
            } else if (fragment && typeof fragment === 'object') {
              const fObj = fragment as Record<string, unknown>;
              const fVal = fObj.content ?? fObj.text ?? fObj.data;
              fragmentText = typeof fVal === 'string' ? fVal : '';
            }
            if (fragmentText.length > 0) {
              linkCount += (fragmentText.match(/\[\[.*?\]\]/g) || []).length;
              tagCount += (fragmentText.match(/#\w+/g) || []).length;
            }
          }
        }

        if (linkCount > 2) {
          suggestions.push({
            description: 'Traverse the link network from this file',
            command: `graph(action='traverse', sourcePath='${readPath}', maxDepth=3)`,
            reason: `This file has ${linkCount} links - explore the broader network`
          });
        }

        if (tagCount > 0) {
          suggestions.push({
            description: 'Find files with similar tags',
            command: `graph(action='tag-traverse', startPath='${readPath}', maxDepth=2)`,
            reason: `This file has ${tagCount} tags - explore related content`
          });
        }
      }
    }

    // Enhanced hints for list operations - suggest exploring discovered files
    if (operation === 'vault' && action === 'list') {
      if (result && Array.isArray(result) && result.length > 1) {
        message = 'Consider exploring relationships between these files.';

        const mdFiles = result.filter((f): f is string => typeof f === 'string' && f.endsWith('.md'));
        if (mdFiles.length >= 2) {
          suggestions.push({
            description: 'Find connections between files in this directory',
            command: `graph(action='path', sourcePath='${mdFiles[0]}', targetPath='${mdFiles[1]}')`,
            reason: 'Discover how files in this directory relate to each other'
          });

          suggestions.push({
            description: 'Analyze tag relationships in this directory',
            command: `graph(action='tag-analysis', folderFilter='${paramStr(params, 'directory') || '/'}')`,
            reason: 'Find common themes and tags among these files'
          });
        }
      } else if (resultObj && 'files' in resultObj && Array.isArray(resultObj.files)) {
        // Handle paginated results
        interface PaginatedFile { name: string; path: string; type: string }
        const paginatedFiles = resultObj.files as PaginatedFile[];
        const mdFiles = paginatedFiles.filter(f => f.name && f.name.endsWith('.md'));
        if (mdFiles.length >= 2) {
          message = 'Consider exploring relationships between these files.';

          suggestions.push({
            description: 'Find connections between files in this directory',
            command: `graph(action='path', sourcePath='${mdFiles[0].path}', targetPath='${mdFiles[1].path}')`,
            reason: 'Discover how files in this directory relate to each other'
          });
        }
      }
    }

    // Enhanced hints for fragments operation - suggest broader exploration
    if (operation === 'vault' && action === 'fragments') {
      const fragments = resultObj?.fragments;
      if (fragments && Array.isArray(fragments) && fragments.length > 0) {
        message = 'Explore connections between documents containing these fragments.';

        const sourcePathsSet = new Set<string>();
        for (const f of fragments) {
          if (f && typeof f === 'object' && 'source' in (f as Record<string, unknown>)) {
            const source = String((f as Record<string, unknown>).source);
            if (source.length > 0) sourcePathsSet.add(source);
          }
        }
        const sourcePaths = [...sourcePathsSet];
        if (sourcePaths.length >= 2) {
          const firstPath = sourcePaths[0];
          const secondPath = sourcePaths[1];
          suggestions.push({
            description: 'Find connections between fragment sources',
            command: `graph(action='path', sourcePath='${firstPath}', targetPath='${secondPath}')`,
            reason: 'Explore how documents with similar content are connected'
          });

          suggestions.push({
            description: 'Traverse network from first fragment source',
            command: `graph(action='traverse', sourcePath='${firstPath}', maxDepth=2)`,
            reason: 'Discover the broader context around this content'
          });
        }
      }
    }
    
    return suggestions.length > 0 ? { message, suggested_next: suggestions } : null;
  }

  private async executeBasesOperation(action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'list':
        return await this.api.listBases();

      case 'read': {
        const basePath = paramStr(params, 'path');
        if (!basePath) {
          throw new Error('Path parameter is required for reading a base');
        }
        return await this.api.readBase(basePath);
      }

      case 'create': {
        const basePath = paramStr(params, 'path');
        const config = params.config as BaseYAML | undefined;
        if (!basePath || !config) {
          throw new Error('Path and config parameters are required for creating a base');
        }
        await this.api.createBase(basePath, config);
        return { success: true, path: basePath };
      }

      case 'query': {
        const basePath = paramStr(params, 'path');
        if (!basePath) {
          throw new Error('Path parameter is required for querying a base');
        }
        return await this.api.queryBase(basePath, paramStr(params, 'viewName'));
      }

      case 'view': {
        const basePath = paramStr(params, 'path');
        const viewName = paramStr(params, 'viewName');
        if (!basePath || !viewName) {
          throw new Error('Path and viewName parameters are required for getting a base view');
        }
        // View is handled by query with viewName
        return await this.api.queryBase(basePath, viewName);
      }

      case 'export': {
        const basePath = paramStr(params, 'path');
        const format = paramStr(params, 'format') as 'csv' | 'json' | 'markdown' | undefined;
        if (!basePath || !format) {
          throw new Error('Path and format parameters are required for exporting a base');
        }
        const exportData = await this.api.exportBase(basePath, format, paramStr(params, 'viewName'));
        return {
          success: true,
          data: exportData,
          format
        };
      }
      
      default:
        throw new Error(`Unknown bases action: ${action}`);
    }
  }
}