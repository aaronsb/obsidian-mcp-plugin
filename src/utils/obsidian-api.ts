import { App, TFile, TFolder, TAbstractFile, Command, getAllTags } from 'obsidian';
import { ObsidianConfig, ObsidianFile, ObsidianFileResponse } from '../types/obsidian';
import { paginateFiles } from './response-limiter';
import { isImageFile as checkIsImageFile, processImageResponse, IMAGE_PROCESSING_PRESETS } from './image-handler';
import { getVersion } from '../version';
import { SearchResult } from './advanced-search';
import { SearchFacade } from './search-facade';
import { MCPIgnoreManager } from '../security/mcp-ignore-manager';
import { Debug } from './debug';
import { BasesAPI } from './bases-api';
import { BaseYAML, BaseQueryResult as BasesQueryResult } from '../types/bases-yaml';
import { InputValidator, ValidationException } from '../validation/input-validator';

export class ObsidianAPI {
  private app: App;
  private config: ObsidianConfig;
  private plugin?: any; // Reference to the plugin for accessing MCP server info
  private ignoreManager?: MCPIgnoreManager;
  private basesAPI: BasesAPI;
  private validator: InputValidator;
  private searchFacade: SearchFacade;

  constructor(app: App, config?: ObsidianConfig, plugin?: any) {
    this.app = app;
    this.config = config || { apiKey: '', apiUrl: '' };
    this.plugin = plugin;
    this.ignoreManager = plugin?.ignoreManager;
    this.basesAPI = new BasesAPI(app);
    this.searchFacade = new SearchFacade(app);

    // Initialize input validator with plugin settings or defaults
    this.validator = new InputValidator(plugin?.settings?.validation || {});

    Debug.log(`ObsidianAPI initialized with ignoreManager: ${!!this.ignoreManager}, enabled: ${this.ignoreManager?.getEnabled()}`);
  }

  // Getter to access the App instance for graph operations
  getApp(): App {
    return this.app;
  }

  // Server info
  async getServerInfo() {
    const baseInfo = {
      authenticated: true,
      cors: true,
      ok: true,
      service: 'Obsidian MCP Plugin',
      versions: {
        obsidian: (this.app as any).appVersion || '1.0.0',
        'self': getVersion()
      }
    };

    // Add MCP server connection info if plugin is available
    if (this.plugin && this.plugin.mcpServer) {
      return {
        ...baseInfo,
        mcp: {
          running: this.plugin.mcpServer.isServerRunning(),
          port: this.plugin.settings?.httpPort || 3001,
          connections: this.plugin.mcpServer.getConnectionCount() || 0,
          vault: this.app.vault.getName()
        }
      };
    }

    return baseInfo;
  }

  // Active file operations
  async getActiveFile(): Promise<ObsidianFile> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      throw new Error('No active file');
    }

    const content = await this.app.vault.read(activeFile);

    // Extract metadata from cache
    const cache = this.app.metadataCache.getFileCache(activeFile);
    const tags = cache ? (getAllTags(cache) || []) : [];
    const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : {};

    // Remove position metadata from frontmatter (internal Obsidian data)
    if (frontmatter.position) {
      delete frontmatter.position;
    }

    return {
      path: activeFile.path,
      content,
      tags,
      frontmatter
    };
  }

  async updateActiveFile(content: string) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      throw new Error('No active file');
    }

    await this.app.vault.modify(activeFile, content);
    return { success: true };
  }

  async appendToActiveFile(content: string) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      throw new Error('No active file');
    }

    const existingContent = await this.app.vault.read(activeFile);
    await this.app.vault.modify(activeFile, existingContent + content);
    return { success: true };
  }

  async deleteActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      throw new Error('No active file');
    }

    await this.app.fileManager.trashFile(activeFile);
    return { success: true };
  }

  async patchActiveFile(params: unknown) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      throw new Error('No active file');
    }

    return await this.patchVaultFile(activeFile.path, params);
  }

  // Vault file operations
  async listFiles(directory?: string): Promise<string[]> {
    const vault = this.app.vault;
    let files: TAbstractFile[];
    
    if (directory && directory !== '/') {
      const folder = vault.getAbstractFileByPath(directory);
      if (!folder || !(folder instanceof TFolder)) {
        throw new Error(`Directory not found: ${directory}`);
      }
      files = folder.children;
    } else {
      files = vault.getAllLoadedFiles();
    }

    // Return file paths, filtering out folders and excluded paths
    const filePaths = files
      .filter(file => file instanceof TFile)
      .map(file => file.path)
      .sort();
    
    // Filter out excluded paths
    return this.ignoreManager ? this.ignoreManager.filterPaths(filePaths) : filePaths;
  }

  async listFilesPaginated(
    directory?: string, 
    page: number = 1, 
    pageSize: number = 20
  ): Promise<{
    files: Array<{
      path: string;
      name: string;
      type: 'file' | 'folder';
      size?: number;
      extension?: string;
      modified?: number;
    }>;
    page: number;
    pageSize: number;
    totalFiles: number;
    totalPages: number;
    directory?: string;
  }> {
    const vault = this.app.vault;
    let files: TAbstractFile[];
    
    if (directory && directory !== '/') {
      const folder = vault.getAbstractFileByPath(directory);
      if (!folder || !(folder instanceof TFolder)) {
        throw new Error(`Directory not found: ${directory}`);
      }
      files = folder.children;
    } else {
      files = vault.getAllLoadedFiles();
    }

    // Create detailed file objects
    const fileObjects = files.map(file => {
      const isFile = file instanceof TFile;
      const result: any = {
        path: file.path,
        name: file.name,
        type: isFile ? 'file' : 'folder'
      };

      if (isFile) {
        result.size = file.stat.size;
        result.extension = file.extension;
        result.modified = file.stat.mtime;
      }

      return result;
    }).sort((a: any, b: any) => {
      // Sort folders first, then files, alphabetically
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return paginateFiles(fileObjects, page, pageSize, directory);
  }

  async getFile(path: string): Promise<ObsidianFileResponse> {
    // Check if path is excluded
    if (this.ignoreManager && this.ignoreManager.isExcluded(path)) {
      throw new Error(`File not found: ${path}`);
    }
    
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    // Check if it's an image file
    if (checkIsImageFile(path)) {
      const arrayBuffer = await this.app.vault.readBinary(file);
      return await processImageResponse(path, arrayBuffer, IMAGE_PROCESSING_PRESETS.none);
    }

    // Regular text file
    const content = await this.app.vault.read(file);

    // Extract metadata from cache
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache ? (getAllTags(cache) || []) : [];
    const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : {};

    // Remove position metadata from frontmatter (internal Obsidian data)
    if (frontmatter.position) {
      delete frontmatter.position;
    }

    return {
      path: file.path,
      content,
      tags,
      frontmatter
    };
  }

  async createFile(path: string, content: string) {
    // Validate input
    const validationResult = this.validator.validate('file.create', { path, content });
    if (!validationResult.valid) {
      throw new ValidationException(
        validationResult.errors || [],
        `Validation failed for createFile: ${validationResult.errors?.map(e => e.message).join(', ')}`
      );
    }

    // Check if path is excluded
    if (this.ignoreManager && this.ignoreManager.isExcluded(path)) {
      throw new Error(`Access denied: ${path}`);
    }

    // Ensure directory exists
    const dirPath = path.substring(0, path.lastIndexOf('/'));
    if (dirPath && !this.app.vault.getAbstractFileByPath(dirPath)) {
      await this.ensureDirectoryExists(dirPath);
    }

    const result = await this.withVaultRetry(
      async () => {
        const file = await this.app.vault.create(path, content);
        return {
          success: true,
          path: file.path,
          name: file.name
        };
      },
      'file creation',
      500 // Base delay for file operations
    );
    return result;
  }

  async updateFile(path: string, content: string) {
    // Validate input
    const validationResult = this.validator.validate('file.update', { path, content });
    if (!validationResult.valid) {
      throw new ValidationException(
        validationResult.errors || [],
        `Validation failed for updateFile: ${validationResult.errors?.map(e => e.message).join(', ')}`
      );
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    await this.app.vault.modify(file, content);
    return { success: true };
  }

  async deleteFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    await this.app.fileManager.trashFile(file);
    return { success: true };
  }

  async appendToFile(path: string, content: string) {
    // Validate input
    const validationResult = this.validator.validate('file.append', { content });
    if (!validationResult.valid) {
      throw new ValidationException(
        validationResult.errors || [],
        `Validation failed for appendToFile: ${validationResult.errors?.map(e => e.message).join(', ')}`
      );
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    const existingContent = await this.app.vault.read(file);

    // Validate combined content size
    const combinedValidation = this.validator.validate('file.append', { content: existingContent + content });
    if (!combinedValidation.valid) {
      throw new ValidationException(
        combinedValidation.errors || [],
        `Validation failed: Combined file size would exceed limit`
      );
    }

    await this.app.vault.modify(file, existingContent + content);
    return { success: true };
  }

  async patchVaultFile(path: string, params: any) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    let content = await this.app.vault.read(file);
    
    // Handle structured targeting (heading, block, frontmatter)
    if (params.targetType && params.target) {
      content = await this.applyStructuredPatch(content, params);
    } 
    // Handle legacy patch operations
    else if (params.operation === 'replace') {
      if (params.old_text && params.new_text) {
        content = content.replace(params.old_text, params.new_text);
      }
    } else if (params.operation === 'insert') {
      if (params.position !== undefined) {
        content = content.slice(0, params.position) + params.text + content.slice(params.position);
      }
    } else if (params.operation === 'delete') {
      if (params.start !== undefined && params.end !== undefined) {
        content = content.slice(0, params.start) + content.slice(params.end);
      }
    }

    await this.app.vault.modify(file, content);
    return { success: true, updated_content: content };
  }

  private async applyStructuredPatch(content: string, params: any): Promise<string> {
    const { targetType, target, operation, content: patchContent } = params;
    
    switch (targetType) {
      case 'heading':
        return this.patchHeading(content, target, operation, patchContent);
      case 'block':
        return this.patchBlock(content, target, operation, patchContent);
      case 'frontmatter':
        return this.patchFrontmatter(content, target, operation, patchContent);
      default:
        throw new Error(`Unknown targetType: ${targetType}`);
    }
  }

  private patchHeading(content: string, headingPath: string, operation: string, patchContent: string): string {
    const lines = content.split('\n');
    const headingHierarchy = headingPath.split('::').map(h => h.trim());
    
    // Find the target heading
    let currentLevel = 0;
    let targetLineIndex = -1;
    let endLineIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();
        
        // Check if we're at the right level in hierarchy
        if (currentLevel < headingHierarchy.length && 
            headingText === headingHierarchy[currentLevel]) {
          currentLevel++;
          
          if (currentLevel === headingHierarchy.length) {
            targetLineIndex = i;
            // Find where this section ends
            for (let j = i + 1; j < lines.length; j++) {
              const nextHeadingMatch = lines[j].match(/^(#{1,6})\s+/);
              if (nextHeadingMatch && nextHeadingMatch[1].length <= level) {
                endLineIndex = j;
                break;
              }
            }
            if (endLineIndex === -1) {
              endLineIndex = lines.length;
            }
            break;
          }
        } else if (level <= currentLevel) {
          // Reset if we've moved to a different section
          currentLevel = 0;
        }
      }
    }
    
    if (targetLineIndex === -1) {
      throw new Error(`Heading not found: ${headingPath}`);
    }
    
    // Apply the operation
    switch (operation) {
      case 'append': {
        // Add content at the end of the section
        // Fix for list continuity - thanks to @that0n3guy (PR #44)
        const lastLine = endLineIndex > 0 ? lines[endLineIndex - 1] : '';
        const isLastLineEmpty = lastLine.trim() === '';
        const listRegex = /^(\s*)([-*+]|\d+\.)\s+/;
        const isPatchList = listRegex.test(patchContent);

        // Find the last non-empty line to check if it's a list
        let lastNonEmptyLine = '';
        for (let i = endLineIndex - 1; i >= targetLineIndex + 1; i--) {
          if (lines[i].trim() !== '') {
            lastNonEmptyLine = lines[i];
            break;
          }
        }
        const isLastNonEmptyLineList = listRegex.test(lastNonEmptyLine);

        if (isLastLineEmpty && isLastNonEmptyLineList && isPatchList) {
          // Preserve list continuity by replacing empty line
          lines.splice(endLineIndex - 1, 1, patchContent);
        } else if (!isLastLineEmpty && isLastNonEmptyLineList && isPatchList) {
          // Append list item without blank line
          lines.splice(endLineIndex, 0, patchContent);
        } else {
          // Default: add blank line separator (original behavior)
          lines.splice(endLineIndex, 0, '', patchContent);
        }
        break;
      }
      case 'prepend':
        // Add content right after the heading
        lines.splice(targetLineIndex + 1, 0, '', patchContent);
        break;
      case 'replace': {
        // Replace the entire section content (keeping the heading)
        const sectionLines = endLineIndex - targetLineIndex - 1;
        lines.splice(targetLineIndex + 1, sectionLines, '', patchContent);
        break;
      }
    }
    
    return lines.join('\n');
  }

  private patchBlock(content: string, blockId: string, operation: string, patchContent: string): string {
    const lines = content.split('\n');
    let blockLineIndex = -1;
    
    // Find the block by ID (blocks end with ^blockId)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().endsWith(`^${blockId}`)) {
        blockLineIndex = i;
        break;
      }
    }
    
    if (blockLineIndex === -1) {
      throw new Error(`Block not found: ^${blockId}`);
    }
    
    // Apply the operation
    switch (operation) {
      case 'append':
        lines[blockLineIndex] = lines[blockLineIndex].replace(`^${blockId}`, `${patchContent} ^${blockId}`);
        break;
      case 'prepend': {
        const blockContent = lines[blockLineIndex].replace(`^${blockId}`, '').trim();
        lines[blockLineIndex] = `${patchContent} ${blockContent} ^${blockId}`;
        break;
      }
      case 'replace':
        lines[blockLineIndex] = `${patchContent} ^${blockId}`;
        break;
    }
    
    return lines.join('\n');
  }

  private patchFrontmatter(content: string, field: string, operation: string, patchContent: string): string {
    const lines = content.split('\n');
    let inFrontmatter = false;
    let frontmatterStart = -1;
    let frontmatterEnd = -1;
    
    // Find frontmatter boundaries
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
          frontmatterStart = i;
        } else {
          frontmatterEnd = i;
          break;
        }
      }
    }
    
    // If no frontmatter exists, create it
    if (frontmatterStart === -1) {
      lines.unshift('---', `${field}: ${patchContent}`, '---', '');
      return lines.join('\n');
    }
    
    // Find the field in frontmatter
    let fieldLineIndex = -1;
    for (let i = frontmatterStart + 1; i < frontmatterEnd; i++) {
      if (lines[i].startsWith(`${field}:`)) {
        fieldLineIndex = i;
        break;
      }
    }
    
    switch (operation) {
      case 'append':
        if (fieldLineIndex !== -1) {
          const currentValue = lines[fieldLineIndex].substring(field.length + 1).trim();
          lines[fieldLineIndex] = `${field}: ${currentValue} ${patchContent}`;
        } else {
          lines.splice(frontmatterEnd, 0, `${field}: ${patchContent}`);
        }
        break;
      case 'prepend':
        if (fieldLineIndex !== -1) {
          const currentValue = lines[fieldLineIndex].substring(field.length + 1).trim();
          lines[fieldLineIndex] = `${field}: ${patchContent} ${currentValue}`;
        } else {
          lines.splice(frontmatterEnd, 0, `${field}: ${patchContent}`);
        }
        break;
      case 'replace':
        if (fieldLineIndex !== -1) {
          lines[fieldLineIndex] = `${field}: ${patchContent}`;
        } else {
          lines.splice(frontmatterEnd, 0, `${field}: ${patchContent}`);
        }
        break;
    }
    
    return lines.join('\n');
  }

  /**
   * Check if a file is readable as text (not binary)
   */
  private isTextFile(file: any): boolean {
    const textExtensions = new Set([
      'md', 'txt', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml',
      'csv', 'log', 'py', 'java', 'cpp', 'c', 'h', 'php', 'rb', 'go', 'rs',
      'sql', 'sh', 'bat', 'ps1', 'ini', 'conf', 'config', 'env'
    ]);
    return textExtensions.has(file.extension.toLowerCase());
  }

  // Search operations

  async searchPaginated(
    query: string,
    page: number = 1,
    pageSize: number = 10,
    strategy: 'filename' | 'content' | 'combined' = 'combined',
    includeContent: boolean = true,
    options?: { ranked?: boolean; includeSnippets?: boolean; snippetLength?: number }
  ): Promise<{
    query: string;
    page: number;
    pageSize: number;
    totalResults: number;
    totalPages: number;
    results: SearchResult[];
    method: string;
    truncated?: boolean;
    originalCount?: number;
    message?: string;
    workflow?: {
      message: string;
      suggested_next: Array<{
        description: string;
        command: string;
        reason: string;
      }>;
    };
  }> {
    // Validate search query
    const validationResult = this.validator.validate('search.query', { query });
    if (!validationResult.valid) {
      throw new ValidationException(
        validationResult.errors || [],
        `Validation failed for search: ${validationResult.errors?.map(e => e.message).join(', ')}`
      );
    }

    // Delegate to SearchFacade for all search operations
    const facadeResponse = await this.searchFacade.searchPaginated(query, {
      page,
      pageSize,
      strategy: strategy as 'filename' | 'content' | 'combined' | 'auto',
      includeSnippets: options?.includeSnippets ?? includeContent,
      snippetLength: options?.snippetLength,
      ranked: options?.ranked
    });

    // Apply ignore filtering to results (security concern)
    const filteredResults = this.ignoreManager
      ? facadeResponse.results.filter(r => !this.ignoreManager!.isExcluded(r.path))
      : facadeResponse.results;

    // Convert to SearchResult format and build response
    const response: {
      query: string;
      page: number;
      pageSize: number;
      totalResults: number;
      totalPages: number;
      results: SearchResult[];
      method: string;
      workflow?: {
        message: string;
        suggested_next: Array<{
          description: string;
          command: string;
          reason: string;
        }>;
      };
    } = {
      query: facadeResponse.query,
      page: facadeResponse.page,
      pageSize: facadeResponse.pageSize,
      totalResults: facadeResponse.totalResults,
      totalPages: facadeResponse.totalPages,
      results: filteredResults.map(r => ({
        path: r.path,
        title: r.title,
        score: r.score,
        snippet: r.snippet,
        metadata: r.metadata
      })),
      method: facadeResponse.method
    };

    Debug.log(`Search found ${response.totalResults} results for query: ${query}`);
    if (response.results.length > 0) {
      Debug.log('First few results:', response.results.slice(0, 3).map(r => ({ path: r.path, score: r.score })));
    }

    // Add workflow hints if results were found
    if (response.results.length > 0) {
      const suggestions = [
        {
          description: 'View a specific file',
          command: 'view:file',
          reason: 'To see the full content of a file'
        },
        {
          description: 'Read file fragments',
          command: 'vault:fragments',
          reason: 'To get relevant excerpts from large files'
        },
        {
          description: 'Edit a file',
          command: 'edit:window',
          reason: 'To modify content in text files'
        }
      ];

      // Add pagination suggestion only for first few pages
      if (response.page < response.totalPages && response.page <= 3) {
        suggestions.push({
          description: 'Get next page of results',
          command: 'vault:search',
          reason: `View page ${response.page + 1} of ${response.totalPages} (use page: ${response.page + 1})`
        });
      }

      response.workflow = {
        message: `Found ${response.totalResults} results${response.totalPages > 1 ? ` (page ${response.page} of ${response.totalPages})` : ''}. You can read, view, or edit these files.`,
        suggested_next: suggestions
      };
    }

    return response;
  }

  // Obsidian integration
  async openFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    return { success: true };
  }

  async getCommands(): Promise<Command[]> {
    const commands = (this.app as any).commands?.commands;
    if (!commands) {
      return [];
    }

    return Object.values(commands).map((cmd: any) => ({
      id: cmd.id,
      name: cmd.name,
      icon: cmd.icon
    }));
  }

  async executeCommand(commandId: string) {
    const success = (this.app as any).commands?.executeCommandById(commandId);
    return { 
      success: !!success,
      commandId 
    };
  }

  // Helper methods
  private async ensureDirectoryExists(dirPath: string) {
    const parts = dirPath.split('/').filter(part => part);
    let currentPath = '';
    
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        await this.createFolderWithRetry(currentPath);
      }
    }
  }

  private async createFolderWithRetry(folderPath: string): Promise<void> {
    await this.withVaultRetry(
      async () => {
        await this.app.vault.createFolder(folderPath);
      },
      'folder creation',
      300 // Base delay for folder operations
    );
  }

  /**
   * Universal retry mechanism for Vault operations that may conflict with sync processes
   * Handles iCloud Drive, OneDrive, Dropbox, and other sync service timing issues
   * 
   * @param operation - Async function to execute with retry logic
   * @param operationType - Human-readable description for logging
   * @param baseDelayMs - Base delay in milliseconds (exponentially increased per retry)
   * @param maxRetries - Maximum number of retry attempts
   * @returns Result of the operation
   */
  private async withVaultRetry<T>(
    operation: () => Promise<T>,
    operationType: string,
    baseDelayMs: number = 500,
    maxRetries: number = 3
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        // Check if this is a sync-related conflict error
        const isSyncConflictError = error.message && (
          error.message.includes('already exists') ||
          error.message.includes('file exists') ||
          error.message.includes('folder exists') ||
          error.message.includes('EEXIST') ||
          error.message.includes('ENOENT') || // File disappeared during sync
          error.message.includes('EBUSY') ||  // File locked by sync process
          error.message.includes('EPERM')     // Permission denied during sync
        );

        if (isSyncConflictError && attempt < maxRetries - 1) {
          // Exponential backoff: allow time for sync processes to stabilize
          const delay = Math.pow(2, attempt) * baseDelayMs;
          Debug.log(`${operationType} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms... Error: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // If it's the final attempt or not a sync-related error, re-throw
        throw error;
      }
    }

    // This should never be reached due to the loop logic, but TypeScript needs it
    throw new Error(`Failed ${operationType} after ${maxRetries} attempts`);
  }

  // ============================================
  // Bases API Methods
  // ============================================

  /**
   * List all bases in the vault
   */
  async listBases(): Promise<Array<{ path: string; name: string; views: string[] }>> {
    return await this.basesAPI.listBases();
  }

  /**
   * Read a base configuration
   */
  async readBase(path: string): Promise<BaseYAML> {
    return await this.basesAPI.readBase(path);
  }

  /**
   * Create a new base
   */
  async createBase(path: string, config: BaseYAML): Promise<void> {
    return await this.basesAPI.createBase(path, config);
  }

  /**
   * Query a base with optional view
   */
  async queryBase(path: string, viewName?: string): Promise<BasesQueryResult> {
    return await this.basesAPI.queryBase(path, viewName);
  }

  /**
   * Export base data
   */
  async exportBase(path: string, format: 'csv' | 'json' | 'markdown', viewName?: string): Promise<string> {
    return await this.basesAPI.exportBase(path, format, viewName);
  }

}