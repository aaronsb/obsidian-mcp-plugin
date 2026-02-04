import { Debug } from '../utils/debug';
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
import { StateTokenManager } from './state-tokens';
import { limitResponse } from '../utils/response-limiter';
import { isImageFile, ObsidianFileResponse } from '../types/obsidian';
import { UniversalFragmentRetriever } from '../indexing/fragment-retriever';
import { readFileWithFragments } from '../utils/file-reader';
import { GraphSearchTool, GraphSearchParams } from '../tools/graph-search';
import { GraphSearchTool as GraphSearchTraversalTool } from '../tools/graph-search-tool';
import { GraphTagTool } from '../tools/graph-tag-tool';
import { App } from 'obsidian';
import { InputValidator, ValidationException } from '../validation/input-validator';
import { BaseYAML } from '../types/bases-yaml';

/** Type alias for operation parameters passed through the semantic router */
type Params = Record<string, unknown>;

/** Search result item from vault search */
interface SearchResultItem {
  path: string;
  title?: string;
  score?: number;
  type?: string;
  context?: string;
}

/** Helper to safely extract a string from params */
function paramStr(params: Params, key: string): string | undefined {
  const val = params[key];
  return typeof val === 'string' ? val : undefined;
}

/** Helper to safely extract a number from params */
function paramNum(params: Params, key: string): number | undefined {
  const val = params[key];
  return typeof val === 'number' ? val : undefined;
}

/** Helper to safely extract a boolean from params */
function paramBool(params: Params, key: string): boolean | undefined {
  const val = params[key];
  return typeof val === 'boolean' ? val : undefined;
}

export class SemanticRouter {
  private config!: WorkflowConfig;
  private context: SemanticContext = {};
  private api: ObsidianAPI;
  private tokenManager: StateTokenManager;
  private fragmentRetriever: UniversalFragmentRetriever;
  private graphSearchTool?: GraphSearchTool;
  private graphSearchTraversalTool?: GraphSearchTraversalTool;
  private graphTagTool?: GraphTagTool;
  private app?: App;
  private validator: InputValidator;

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
        return this.executeVaultOperation(action, params);
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
  
  private async executeVaultOperation(action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'list': {
        // Translate "/" to undefined for root directory
        const dirParam = paramStr(params, 'directory');
        const directory = dirParam === '/' ? undefined : dirParam;

        // Use paginated list if page parameters are provided
        if (params.page || params.pageSize) {
          const page = parseInt(paramStr(params, 'page') ?? '1') || 1;
          const pageSize = parseInt(paramStr(params, 'pageSize') ?? '20') || 20;
          return await this.api.listFilesPaginated(directory, page, pageSize);
        }

        // Fallback to simple list for backwards compatibility
        return await this.api.listFiles(directory);
      }
      case 'read': {
        const path = paramStr(params, 'path') ?? '';
        const strategy = paramStr(params, 'strategy') as 'auto' | 'adaptive' | 'proximity' | 'semantic' | undefined;
        return await readFileWithFragments(this.api, this.fragmentRetriever, {
          path,
          returnFullFile: paramBool(params, 'returnFullFile'),
          query: paramStr(params, 'query'),
          strategy,
          maxFragments: paramNum(params, 'maxFragments')
        });
      }
      case 'fragments': {
        // Dedicated fragment search across multiple files
        const fragmentQuery = paramStr(params, 'query') ?? paramStr(params, 'path') ?? '';

        // Skip indexing if no query provided
        if (!fragmentQuery || fragmentQuery.trim().length === 0) {
          return {
            result: [],
            context: {
              operation: 'vault',
              action: 'fragments',
              error: 'No query provided for fragment search'
            }
          };
        }

        try {
          // Only index files that match the query to avoid indexing entire vault
          // This is a lazy indexing approach - index on demand
          const searchResults = await this.api.searchPaginated(fragmentQuery, 1, 20, 'combined', false);

          // Index only the files that match the search
          if (searchResults && searchResults.results && searchResults.results.length > 0) {
            for (const result of searchResults.results.slice(0, 20)) { // Limit to first 20 files
              try {
                const filePath = result.path;
                if (filePath && filePath.endsWith('.md')) {
                  const fileResponse = await this.api.getFile(filePath);
                  let content: string;

                  if (typeof fileResponse === 'string') {
                    content = fileResponse;
                  } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
                    content = fileResponse.content;
                  } else {
                    continue;
                  }

                  const docId = `file:${filePath}`;
                  await this.fragmentRetriever.indexDocument(docId, filePath, content);
                }
              } catch (e) {
                // Skip files that can't be indexed
                Debug.log(`Skipping file during fragment indexing:`, e);
              }
            }
          }

          // Search for fragments in indexed documents
          const fragmentResponse = await this.fragmentRetriever.retrieveFragments(fragmentQuery, {
            strategy: (paramStr(params, 'strategy') as 'auto' | 'adaptive' | 'proximity' | 'semantic') || 'auto',
            maxFragments: paramNum(params, 'maxFragments') || 5
          });

          return fragmentResponse;
        } catch (error) {
          Debug.error('Fragment search failed:', error);
          return {
            result: [],
            context: {
              operation: 'vault',
              action: 'fragments',
              error: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
      case 'create':
        return await this.api.createFile(paramStr(params, 'path') ?? '', paramStr(params, 'content') ?? '');
      case 'update':
        return await this.api.updateFile(String(params.path), String(params.content));
      case 'delete':
        return await this.api.deleteFile(String(params.path));
      case 'search': {
        // Validate query
        const queryStr = paramStr(params, 'query');
        if (!queryStr || queryStr.trim().length === 0) {
          return {
            query: queryStr || '',
            page: 1,
            pageSize: 10,
            totalResults: 0,
            totalPages: 0,
            results: [],
            method: 'error',
            error: 'Search query is required',
            hint: 'Please provide a search query. Examples: "keyword", "tag:#example", "file:name.md"'
          };
        }

        // Use advanced search with ranking and snippets
        try {
          const page = parseInt(paramStr(params, 'page') ?? '1') || 1;
          const pageSize = parseInt(paramStr(params, 'pageSize') ?? '10') || 10;
          // Use searchStrategy for search, fall back to strategy for backward compatibility
          const strategy = (paramStr(params, 'searchStrategy') || paramStr(params, 'strategy') || 'combined') as 'filename' | 'content' | 'combined';
          const includeContent = params.includeContent !== false; // Default to true

          // Build search options from new parameters
          const searchOptions: {
            ranked?: boolean;
            includeSnippets?: boolean;
            snippetLength?: number;
          } = {};

          if (params.ranked !== undefined) {
            searchOptions.ranked = Boolean(params.ranked);
          }
          if (params.includeSnippets !== undefined) {
            searchOptions.includeSnippets = Boolean(params.includeSnippets);
          }
          if (params.snippetLength !== undefined) {
            searchOptions.snippetLength = parseInt(paramStr(params, 'snippetLength') ?? '0');
          }

          const searchResults = await this.api.searchPaginated(
            queryStr,
            page,
            pageSize,
            strategy,
            includeContent,
            searchOptions
          );

          // Check if results are valid
          if (!searchResults || typeof searchResults !== 'object') {
            throw new Error('Invalid search response from API');
          }

          return searchResults;
        } catch (searchError) {
          Debug.error('Search failed:', searchError);

          // Try fallback with basic search strategy
          try {
            const fallbackResults = await this.api.searchPaginated(
              queryStr,
              1,
              10,
              'filename', // Use simple filename search as fallback
              false // Don't include content to avoid errors
            );

            if (fallbackResults && fallbackResults.results && fallbackResults.results.length > 0) {
              return {
                ...fallbackResults,
                method: 'filename_fallback',
                warning: 'Using filename-only search due to advanced search failure'
              };
            }
          } catch (fallbackError) {
            Debug.error('Fallback search also failed:', fallbackError);
          }

          // Return error with helpful information
          return {
            query: queryStr,
            page: 1,
            pageSize: 10,
            totalResults: 0,
            totalPages: 0,
            results: [],
            method: 'error',
            error: searchError instanceof Error ? searchError.message : String(searchError),
            hint: 'Try simplifying your query or check if the vault is accessible'
          };
        }
      }
      case 'move': {
        const path = paramStr(params, 'path');
        const destination = paramStr(params, 'destination');
        const overwrite = paramBool(params, 'overwrite') ?? false;

        if (!path || !destination) {
          throw new Error('Both path and destination are required for move operation');
        }

        // Check if source file exists
        const sourceFile = await this.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`Source file not found: ${path}`);
        }

        // Check if destination already exists
        try {
          const destFile = await this.api.getFile(destination);
          if (destFile && !overwrite) {
            throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
          }
        } catch {
          // File doesn't exist, which is what we want
        }

        // Directory creation is handled automatically by createFile

        // Use Obsidian's rename method (which handles moves)
        if (this.app) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file && 'extension' in file) {
            await this.app.fileManager.renameFile(file, destination);
            return { 
              success: true, 
              oldPath: path,
              newPath: destination,
              workflow: {
                message: `File moved successfully from ${path} to ${destination}`,
                suggested_next: [
                  {
                    description: 'View the moved file',
                    command: `view(action='file', path='${destination}')`
                  },
                  {
                    description: 'Edit the moved file',
                    command: `edit(action='window', path='${destination}', oldText='...', newText='...')`
                  }
                ]
              }
            };
          }
        }
        
        // Fallback: copy and delete
        const sourceFileData = await this.api.getFile(path);
        if (isImageFile(sourceFileData)) {
          throw new Error('Cannot move image files using fallback method');
        }
        const content = sourceFileData.content;
        await this.api.createFile(destination, content);
        await this.api.deleteFile(path);
        
        return { 
          success: true, 
          oldPath: path,
          newPath: destination,
          workflow: {
            message: `File moved successfully from ${path} to ${destination}`,
            suggested_next: [
              {
                description: 'View the moved file',
                command: `view(action='file', path='${destination}')`
              },
              {
                description: 'Edit the moved file',
                command: `edit(action='window', path='${destination}', oldText='...', newText='...')`
              }
            ]
          }
        };
      }
      
      case 'rename': {
        const path = paramStr(params, 'path');
        const newName = paramStr(params, 'newName');
        const overwrite = paramBool(params, 'overwrite') ?? false;

        if (!path || !newName) {
          throw new Error('Both path and newName are required for rename operation');
        }

        // Check if source file exists
        const sourceFile = await this.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`File not found: ${path}`);
        }

        // Extract directory from current path
        const lastSlash = path.lastIndexOf('/');
        const dir = lastSlash >= 0 ? path.substring(0, lastSlash) : '';
        const newPath = dir ? `${dir}/${newName}` : newName;

        // Check if destination already exists
        try {
          const destFile = await this.api.getFile(newPath);
          if (destFile && !overwrite) {
            throw new Error(`File already exists: ${newPath}. Set overwrite=true to replace.`);
          }
        } catch {
          // File doesn't exist, which is what we want
        }

        // Use Obsidian's rename method
        if (this.app) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file && 'extension' in file) {
            await this.app.fileManager.renameFile(file, newPath);
            return { 
              success: true,
              oldPath: path,
              newPath: newPath,
              workflow: {
                message: `File renamed successfully from ${path} to ${newPath}`,
                suggested_next: [
                  {
                    description: 'View the renamed file',
                    command: `view(action='file', path='${newPath}')`
                  },
                  {
                    description: 'Edit the renamed file', 
                    command: `edit(action='window', path='${newPath}', oldText='...', newText='...')`
                  }
                ]
              }
            };
          }
        }
        
        // Fallback: copy and delete
        const sourceFileData = await this.api.getFile(path);
        if (isImageFile(sourceFileData)) {
          throw new Error('Cannot rename image files using fallback method');
        }
        const content = sourceFileData.content;
        await this.api.createFile(newPath, content);
        await this.api.deleteFile(path);
        
        return { 
          success: true,
          oldPath: path,
          newPath: newPath,
          workflow: {
            message: `File renamed successfully from ${path} to ${newPath}`,
            suggested_next: [
              {
                description: 'View the renamed file',
                command: `view(action='file', path='${newPath}')`
              },
              {
                description: 'Edit the renamed file',
                command: `edit(action='window', path='${newPath}', oldText='...', newText='...')`
              }
            ]
          }
        };
      }
      
      case 'copy': {
        const path = paramStr(params, 'path');
        const destination = paramStr(params, 'destination');
        const overwrite = paramBool(params, 'overwrite') ?? false;

        if (!path || !destination) {
          throw new Error('Both path and destination are required for copy operation');
        }

        // First try as a file (this will go through security validation)
        try {
          const sourceFile = await this.api.getFile(path);
          return await this.copyFile(path, destination, overwrite, sourceFile);
        } catch {
          // If file operation failed, try as directory (this will also go through security validation)
          try {
            // Test if it's a directory by trying to list its contents
            await this.api.listFiles(path);
            // If listing succeeds, it's a directory
            return await this.copyDirectoryRecursive(path, destination, overwrite);
          } catch {
            // Neither file nor directory worked
            throw new Error(`Source not found or inaccessible: ${path}`);
          }
        }
      }
      
      case 'split': {
        const path = paramStr(params, 'path');
        const splitBy = paramStr(params, 'splitBy');
        const outputPattern = paramStr(params, 'outputPattern');
        const outputDirectory = paramStr(params, 'outputDirectory');

        if (!path || !splitBy) {
          throw new Error('Both path and splitBy are required for split operation');
        }

        // Get the source file
        const sourceFile = await this.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`File not found: ${path}`);
        }

        if (isImageFile(sourceFile)) {
          throw new Error('Cannot split image files');
        }

        // Split the content
        const splitFiles = await this.splitContent(sourceFile.content, params);
        
        // Create output files
        const createdFiles = [];
        const pathParts = path.split('/');
        const filename = pathParts.pop() || '';
        const dir = outputDirectory || pathParts.join('/');
        const [basename, ext] = filename.includes('.') 
          ? [filename.substring(0, filename.lastIndexOf('.')), filename.substring(filename.lastIndexOf('.'))]
          : [filename, ''];
        
        for (let i = 0; i < splitFiles.length; i++) {
          const pattern = outputPattern || '{filename}-{index}{ext}';
          const outputFilename = pattern
            .replace('{filename}', basename)
            .replace('{index}', String(i + 1).padStart(3, '0'))
            .replace('{ext}', ext);
          
          const outputPath = dir ? `${dir}/${outputFilename}` : outputFilename;
          await this.api.createFile(outputPath, splitFiles[i].content);
          
          createdFiles.push({
            path: outputPath,
            lines: splitFiles[i].content.split('\n').length,
            size: splitFiles[i].content.length
          });
        }
        
        return {
          success: true,
          sourceFile: path,
          createdFiles,
          totalFiles: createdFiles.length,
          workflow: {
            message: `Successfully split ${path} into ${createdFiles.length} files`,
            suggested_next: [
              {
                description: 'View one of the split files',
                command: `view(action='file', path='${createdFiles[0]?.path}')`
              },
              {
                description: 'List all created files',
                command: `vault(action='list', directory='${dir || '.'}')`
              },
              {
                description: 'Combine files back together',
                command: `vault(action='combine', paths=${JSON.stringify(createdFiles.map(f => f.path))}, destination='${path}-combined${ext}')`
              }
            ]
          }
        };
      }
      
      case 'combine': {
        const paths = params.paths as string[] | undefined;
        const destination = paramStr(params, 'destination');
        const separator = paramStr(params, 'separator') ?? '\n\n---\n\n';
        const includeFilenames = paramBool(params, 'includeFilenames') ?? false;
        const overwrite = paramBool(params, 'overwrite') ?? false;
        const sortBy = paramStr(params, 'sortBy');
        const sortOrder = paramStr(params, 'sortOrder') ?? 'asc';

        // Validate batch operation
        const validationResult = this.validator.validate('batch.combine', { paths, path: destination });
        if (!validationResult.valid) {
          throw new ValidationException(
            validationResult.errors || [],
            `Validation failed for combine: ${validationResult.errors?.map(e => e.message).join(', ')}`
          );
        }

        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          throw new Error('paths array is required for combine operation');
        }

        if (!destination) {
          throw new Error('destination is required for combine operation');
        }
        
        // Check if destination exists
        try {
          const destFile = await this.api.getFile(destination);
          if (destFile && !overwrite) {
            throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
          }
        } catch {
          // File doesn't exist, which is what we want
        }
        
        // Validate and get all source files
        const sourceFiles = [];
        for (const path of paths) {
          const file = await this.api.getFile(path);
          if (!file) {
            throw new Error(`File not found: ${path}`);
          }
          if (isImageFile(file)) {
            throw new Error(`Cannot combine image files: ${path}`);
          }
          sourceFiles.push({ path, content: file.content });
        }
        
        // Sort files if requested
        if (sortBy) {
          await this.sortFiles(sourceFiles, sortBy, sortOrder);
        }
        
        // Combine content
        const combinedContent = [];
        for (const file of sourceFiles) {
          if (includeFilenames) {
            const filename = file.path.split('/').pop() || file.path;
            combinedContent.push(`# ${filename}`);
            combinedContent.push('');
          }
          combinedContent.push(file.content);
        }
        
        const finalContent = combinedContent.join(separator);
        
        // Create or update destination file
        if (overwrite) {
          await this.api.updateFile(destination, finalContent);
        } else {
          await this.api.createFile(destination, finalContent);
        }
        
        return {
          success: true,
          destination,
          filesCombined: paths.length,
          totalSize: finalContent.length,
          workflow: {
            message: `Successfully combined ${paths.length} files into ${destination}`,
            suggested_next: [
              {
                description: 'View the combined file',
                command: `view(action='file', path='${destination}')`
              },
              {
                description: 'Edit the combined file',
                command: `edit(action='window', path='${destination}', oldText='...', newText='...')`
              },
              {
                description: 'Split the file back into parts',
                command: `vault(action='split', path='${destination}', splitBy='delimiter', delimiter='${separator}')`
              }
            ]
          }
        };
      }
      
      case 'concatenate': {
        const path1 = paramStr(params, 'path1');
        const path2 = paramStr(params, 'path2');
        const concatDest = paramStr(params, 'destination');
        const mode = paramStr(params, 'mode') ?? 'append';

        if (!path1 || !path2) {
          throw new Error('Both path1 and path2 are required for concatenate operation');
        }

        // Determine paths and destination based on mode
        const concatPaths = mode === 'prepend' ? [path2, path1] : [path1, path2];
        const dest = concatDest || (mode === 'new' ? `${path1}-concatenated` : path1);
        
        // Use combine operation internally
        return this.executeVaultOperation('combine', {
          paths: concatPaths,
          destination: dest,
          separator: '\n\n',
          overwrite: mode !== 'new',
          includeFilenames: false
        });
      }
      
      default:
        throw new Error(`Unknown vault action: ${action}`);
    }
  }
  
  private combineSearchResults(apiResults: SearchResultItem[], fallbackResults: SearchResultItem[]): SearchResultItem[] {
    const combined = [...apiResults];
    const existingPaths = new Set(apiResults.map(r => r.path));

    // Add fallback results that aren't already in API results
    for (const fallbackResult of fallbackResults) {
      if (!existingPaths.has(fallbackResult.path)) {
        combined.push(fallbackResult);
      }
    }

    // Sort by score (API results have negative scores, higher is better)
    // Fallback results have positive scores, higher is better
    return combined.sort((a, b) => {
      const scoreA = a.score || 0;
      const scoreB = b.score || 0;
      
      // If both are negative (API results), more negative is better
      if (scoreA < 0 && scoreB < 0) {
        return scoreA - scoreB; // More negative first
      }
      
      // If both are positive (fallback results), higher is better
      if (scoreA > 0 && scoreB > 0) {
        return scoreB - scoreA; // Higher first
      }
      
      // Mixed: prioritize API results (negative scores) over fallback (positive scores)
      if (scoreA < 0 && scoreB > 0) {
        return -1; // API result first
      }
      if (scoreA > 0 && scoreB < 0) {
        return 1; // API result first
      }
      
      return 0;
    });
  }
  
  private async splitContent(content: string, params: Params): Promise<Array<{ content: string }>> {
    const splitBy = paramStr(params, 'splitBy');
    const delimiter = paramStr(params, 'delimiter');
    const level = paramNum(params, 'level');
    const linesPerFile = paramNum(params, 'linesPerFile');
    const maxSize = paramNum(params, 'maxSize');
    const splitFiles: Array<{ content: string }> = [];
    
    switch (splitBy) {
      case 'heading': {
        // Split by markdown headings
        const headingLevel = level || 1;
        const headingRegex = new RegExp(`^${'#'.repeat(headingLevel)}\\s+.+$`, 'gm');
        const matches = Array.from(content.matchAll(headingRegex));
        
        if (matches.length === 0) {
          // No headings found, return original content
          return [{ content }];
        }
        
        // Split content at each heading
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          const nextMatch = matches[i + 1];
          const startIndex = match.index || 0;
          const endIndex = nextMatch ? nextMatch.index : content.length;
          
          if (i === 0 && startIndex > 0) {
            // Content before first heading
            splitFiles.push({ content: content.substring(0, startIndex).trim() });
          }
          
          const section = content.substring(startIndex, endIndex).trim();
          if (section) {
            splitFiles.push({ content: section });
          }
        }
        break;
      }
      
      case 'delimiter': {
        // Split by custom delimiter
        const delim = delimiter || '---';
        const parts = content.split(delim);
        
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) {
            splitFiles.push({ content: trimmed });
          }
        }
        break;
      }
      
      case 'lines': {
        // Split by line count
        const lines = content.split('\n');
        const chunkSize = linesPerFile || 100;
        
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize).join('\n');
          if (chunk.trim()) {
            splitFiles.push({ content: chunk });
          }
        }
        break;
      }
      
      case 'size': {
        // Split by character count, preserving word boundaries
        const max = maxSize || 10000;
        let currentPos = 0;
        
        while (currentPos < content.length) {
          let endPos = Math.min(currentPos + max, content.length);
          
          // If we're not at the end, try to find a good break point
          if (endPos < content.length) {
            // Look for paragraph break first
            const paragraphBreak = content.lastIndexOf('\n\n', endPos);
            if (paragraphBreak > currentPos && paragraphBreak > endPos - 1000) {
              endPos = paragraphBreak;
            } else {
              // Look for line break
              const lineBreak = content.lastIndexOf('\n', endPos);
              if (lineBreak > currentPos && lineBreak > endPos - 200) {
                endPos = lineBreak;
              } else {
                // Look for sentence end
                const sentenceEnd = content.lastIndexOf('. ', endPos);
                if (sentenceEnd > currentPos && sentenceEnd > endPos - 100) {
                  endPos = sentenceEnd + 1;
                } else {
                  // Look for word boundary
                  const wordBoundary = content.lastIndexOf(' ', endPos);
                  if (wordBoundary > currentPos) {
                    endPos = wordBoundary;
                  }
                }
              }
            }
          }
          
          const chunk = content.substring(currentPos, endPos).trim();
          if (chunk) {
            splitFiles.push({ content: chunk });
          }
          currentPos = endPos;
          
          // Skip whitespace at the beginning of next chunk
          while (currentPos < content.length && /\s/.test(content[currentPos])) {
            currentPos++;
          }
        }
        break;
      }
      
      default:
        throw new Error(`Unknown split strategy: ${splitBy}`);
    }
    
    return splitFiles.length > 0 ? splitFiles : [{ content }];
  }
  
  private async sortFiles(files: Array<{ path: string; content: string }>, sortBy: string, sortOrder: string): Promise<void> {
    // For file metadata, we'd need to use Obsidian's API
    // For now, we'll sort by name and size (which we can calculate)
    
    files.sort((a, b) => {
      let compareValue = 0;
      
      switch (sortBy) {
        case 'name': {
          const nameA = a.path.split('/').pop() || a.path;
          const nameB = b.path.split('/').pop() || b.path;
          compareValue = nameA.localeCompare(nameB);
          break;
        }
          
        case 'size':
          compareValue = a.content.length - b.content.length;
          break;
          
        case 'modified':
        case 'created': {
          // Would need file stats from Obsidian API
          // For now, fall back to name sort
          const fallbackA = a.path.split('/').pop() || a.path;
          const fallbackB = b.path.split('/').pop() || b.path;
          compareValue = fallbackA.localeCompare(fallbackB);
          break;
        }
          
        default:
          compareValue = 0;
      }
      
      return sortOrder === 'desc' ? -compareValue : compareValue;
    });
  }
  
  /**
   * Copy a single file
   */
  private async copyFile(path: string, destination: string, overwrite: boolean, sourceFile: ObsidianFileResponse): Promise<unknown> {
    // Check if destination already exists
    try {
      const destFile = await this.api.getFile(destination);
      if (destFile && !overwrite) {
        throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
      }
    } catch {
      // File doesn't exist, which is what we want
    }

    // Check for image files
    if (isImageFile(sourceFile)) {
      throw new Error('Cannot copy image files - use Obsidian file explorer');
    }
    
    const content = sourceFile.content;
    
    // Create the copy
    if (overwrite) {
      await this.api.updateFile(destination, content);
    } else {
      await this.api.createFile(destination, content);
    }
    
    return { 
      success: true,
      sourcePath: path,
      copiedTo: destination,
      workflow: {
        message: `File copied successfully from ${path} to ${destination}`,
        suggested_next: [
          {
            description: 'View the copied file',
            command: `view(action='file', path='${destination}')`
          },
          {
            description: 'Edit the copied file',
            command: `edit(action='window', path='${destination}', oldText='...', newText='...')`
          },
          {
            description: 'Compare original and copy',
            command: `view(action='file', path='${path}') then view(action='file', path='${destination}')`
          }
        ]
      }
    };
  }

  /**
   * Check if a path is a directory using the paginated listing API that properly identifies folders
   */
  private async isDirectory(path: string): Promise<boolean> {
    try {
      // Method 1: Use Obsidian's vault API to check if path is a folder
      if (this.app) {
        const abstractFile = this.app.vault.getAbstractFileByPath(path);
        if (abstractFile && 'children' in abstractFile) {
          return true; // TFolder has children property
        }
      }
      
      // Method 2: Use paginated listing to check if this path exists as a folder
      try {
        const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.';
        const dirName = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
        
        // Use paginated listing to get detailed file information including type
        const result = await this.api.listFilesPaginated(parentPath === '.' ? undefined : parentPath, 1, 100);
        
        // Check if any item matches our directory name and has type 'folder'
        return result.files.some(file => 
          file.name === dirName && file.type === 'folder'
        );
      } catch {
        // Fallback method: try to list the path directly as a directory
        try {
          await this.api.listFiles(path);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

  /**
   * Recursively copy a directory and all its contents
   */
  private async copyDirectoryRecursive(sourcePath: string, destPath: string, overwrite: boolean): Promise<unknown> {
    const copiedFiles: string[] = [];
    const skippedFiles: string[] = [];
    
    const copyDir = async (srcDir: string, destDir: string) => {
      // Use listFilesPaginated to get both files and directories
      const response = await this.api.listFilesPaginated(srcDir, 1, 1000); // Get large page to avoid pagination
      const items = response.files;
      
      for (const item of items) {
        const srcPath = item.path;
        const relativePath = srcPath.startsWith(srcDir + '/') ? srcPath.substring(srcDir.length + 1) : item.name;
        const destFilePath = `${destDir}/${relativePath}`;
        
        if (item.type === 'folder') {
          // Subdirectory - recurse
          await copyDir(srcPath, destFilePath);
        } else {
          try {
            // File - copy
            const sourceFile = await this.api.getFile(srcPath);
            if (isImageFile(sourceFile)) {
              Debug.warn(`Skipping image file: ${srcPath}`);
              skippedFiles.push(srcPath);
              continue;
            }
            
            // Check destination exists if not overwriting
            if (!overwrite) {
              try {
                await this.api.getFile(destFilePath);
                throw new Error(`Destination exists: ${destFilePath}. Set overwrite=true to replace.`);
              } catch (e: unknown) {
                // File doesn't exist - good to proceed
                if (e instanceof Error && e.message?.includes('Destination exists')) {
                  throw e;
                }
              }
            }

            const content = sourceFile.content;
            if (overwrite) {
              await this.api.updateFile(destFilePath, content);
            } else {
              await this.api.createFile(destFilePath, content);
            }
            copiedFiles.push(destFilePath);
          } catch (error: unknown) {
            if (error instanceof Error && error.message?.includes('Destination exists')) {
              throw error; // Re-throw destination exists errors
            }
            // Log other errors but continue
            const errMsg = error instanceof Error ? error.message : String(error);
            Debug.warn(`Failed to copy ${srcPath}: ${errMsg}`);
            skippedFiles.push(srcPath);
          }
        }
      }
    };
    
    await copyDir(sourcePath, destPath);
    
    return {
      success: true,
      sourcePath,
      destinationPath: destPath,
      filesCount: copiedFiles.length,
      copiedFiles,
      skippedFiles,
      workflow: {
        message: `Directory copied successfully: ${copiedFiles.length} files from ${sourcePath} to ${destPath}${skippedFiles.length > 0 ? ` (${skippedFiles.length} files skipped)` : ''}`,
        suggested_next: [
          {
            description: 'List copied directory contents',
            command: `vault(action='list', directory='${destPath}')`
          },
          {
            description: 'View a copied file',
            command: `view(action='file', path='${copiedFiles[0] || destPath + '/README.md'}')`
          },
          ...(skippedFiles.length > 0 ? [{
            description: 'Review skipped files',
            command: `Review skipped files: ${skippedFiles.slice(0, 3).join(', ')}${skippedFiles.length > 3 ? '...' : ''}`
          }] : [])
        ]
      }
    };
  }

  private getFileType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    
    // Image formats
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(ext)) {
      return 'image';
    }
    
    // Video formats
    if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv'].includes(ext)) {
      return 'video';
    }
    
    // Audio formats
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'].includes(ext)) {
      return 'audio';
    }
    
    // Document formats
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
      return 'document';
    }
    
    // Text/code formats
    if (['md', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'cpp', 'c', 'h', 'css', 'html', 'xml'].includes(ext)) {
      return 'text';
    }
    
    return 'binary';
  }
  
  private getSearchWorkflowHints(results: SearchResultItem[]): { available_actions: string[]; note: string } {
    const hasEditableFiles = results.some(r => {
      const type = r.type || this.getFileType(r.path);
      return type === 'text';
    });
    
    const availableActions = [
      "view:file",
      "view:window", 
      "view:open_in_obsidian"
    ];
    
    if (hasEditableFiles) {
      availableActions.push("edit:window");
    }
    
    return {
      available_actions: availableActions,
      note: hasEditableFiles ? 
        "Use with paths from results. Edit only for text files." : 
        "Use with paths from results."
    };
  }
  
  private async performFileBasedSearch(query: string, page: number, pageSize: number, includeContent: boolean = false): Promise<unknown> {
    const lowerQuery = query.toLowerCase();
    const allResults: SearchResultItem[] = [];
    
    const searchDirectory = async (directory?: string) => {
      try {
        const files = await this.api.listFiles(directory);
        
        for (const file of files) {
          const filePath = directory ? `${directory}/${file}` : file;
          
          if (file.endsWith('/')) {
            // Recursively search subdirectories
            await searchDirectory(filePath.slice(0, -1));
          } else {
            try {
              // Check filename first (faster) for all files
              if (file.toLowerCase().includes(lowerQuery)) {
                const isMarkdown = file.endsWith('.md');
                allResults.push({
                  path: filePath,
                  title: isMarkdown ? file.replace('.md', '') : file,
                  score: 2, // Higher score for filename matches
                  type: this.getFileType(file)
                });
              } else if (includeContent && file.endsWith('.md')) {
                // Only read file content if specifically requested
                const fileResponse = await this.api.getFile(filePath);
                let content: string;
                
                if (typeof fileResponse === 'string') {
                  content = fileResponse;
                } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
                  content = fileResponse.content;
                } else {
                  continue;
                }
                
                if (content.toLowerCase().includes(lowerQuery)) {
                  const matches = (content.toLowerCase().split(lowerQuery).length - 1);
                  allResults.push({
                    path: filePath,
                    title: file.replace('.md', ''),
                    context: this.extractContext(content, query, 150),
                    score: matches,
                    type: 'text'
                  });
                }
              }
            } catch (e) {
              // Skip unreadable files
              Debug.warn(`Failed to search file ${filePath}:`, e);
            }
          }
        }
      } catch (e) {
        // Skip unreadable directories
        Debug.warn(`Failed to search directory ${directory}:`, e);
      }
    };
    
    await searchDirectory();
    
    // Sort by score
    allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
    
    // Apply pagination
    const totalResults = allResults.length;
    const totalPages = Math.ceil(totalResults / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    
    const paginatedResults = allResults.slice(startIndex, endIndex);
    
    return {
      query,
      page,
      pageSize,
      totalResults,
      totalPages,
      results: paginatedResults,
      method: 'fallback',
      workflow: this.getSearchWorkflowHints(paginatedResults)
    };
  }
  
  private extractContext(content: string, query: string, maxLength: number = 150): string {
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(query.toLowerCase());
    
    if (index === -1) return '';
    
    const start = Math.max(0, index - maxLength / 2);
    const end = Math.min(content.length, index + query.length + maxLength / 2);
    
    let context = content.substring(start, end);
    if (start > 0) context = '...' + context;
    if (end < content.length) context = context + '...';
    
    return context.trim();
  }
  
  private async indexVaultFiles(): Promise<void> {
    // Index all markdown files in the vault
    const indexDirectory = async (directory?: string) => {
      try {
        const files = await this.api.listFiles(directory);
        
        for (const file of files) {
          const filePath = directory ? `${directory}/${file}` : file;
          
          if (file.endsWith('/')) {
            // Recursively index subdirectories
            await indexDirectory(filePath.slice(0, -1));
          } else if (file.endsWith('.md')) {
            try {
              const fileResponse = await this.api.getFile(filePath);
              let content: string;
              
              // Handle both string and structured responses
              if (typeof fileResponse === 'string') {
                content = fileResponse;
              } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
                content = fileResponse.content;
              } else {
                continue; // Skip if we can't extract content
              }
              
              const docId = `file:${filePath}`;
              await this.fragmentRetriever.indexDocument(docId, filePath, content);
            } catch (e) {
              // Skip unreadable files
              Debug.warn(`Failed to index ${filePath}:`, e);
            }
          }
        }
      } catch (e) {
        // Skip unreadable directories
        Debug.warn(`Failed to index directory ${directory}:`, e);
      }
    };
    
    await indexDirectory();
  }
  
  private async executeEditOperation(action: string, params: Params): Promise<unknown> {
    // Import window edit tools dynamically to avoid circular dependencies
    const { performWindowEdit } = await import('../tools/window-edit.js');
    const buffer = ContentBufferManager.getInstance();

    switch (action) {
      case 'window': {
        const result = await performWindowEdit(
          this.api,
          String(params.path),
          String(params.oldText),
          String(params.newText),
          paramNum(params, 'fuzzyThreshold')
        );
        if (result.isError) {
          throw new Error(result.content[0].text);
        }
        return result;
      }
      case 'append':
        return await this.api.appendToFile(String(params.path), String(params.content));
      case 'patch':
        return await this.api.patchVaultFile(String(params.path), {
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
        const filePath = String(params.path);
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
        return await performWindowEdit(
          this.api,
          String(params.path),
          paramStr(params, 'oldText') || buffered.searchText || '',
          buffered.content,
          paramNum(params, 'fuzzyThreshold')
        );
      }
      default:
        throw new Error(`Unknown edit action: ${action}`);
    }
  }
  
  private async executeViewOperation(action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'file':
        return await this.api.getFile(String(params.path));
      case 'window': {
        // View a portion of a file
        const viewPath = String(params.path);
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
            setTimeout(() => reject(new Error('Timeout: No active file in Obsidian. Please open a file first.')), 5000)
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
        return await this.api.openFile(String(params.path));
        
      default:
        throw new Error(`Unknown view action: ${action}`);
    }
  }
  
  private async executeWorkflowOperation(action: string, _params: Params): Promise<unknown> {
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
        return await this.api.getServerInfo();
      case 'commands':
        return await this.api.getCommands();
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

    return await this.graphSearchTool.search(graphParams);
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
        return pathVal ? this.matchesPattern(pathVal, this.config.context_triggers?.daily_note_pattern) : false;
      }
      default:
        return false;
    }
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