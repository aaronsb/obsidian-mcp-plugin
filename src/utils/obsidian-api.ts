import { App, TFile, TFolder, TAbstractFile, Command, getAllTags } from 'obsidian';
import { ObsidianConfig, ObsidianFile, ObsidianFileResponse } from '../types/obsidian';
import { paginateResults, paginateFiles } from './response-limiter';
import { isImageFile as checkIsImageFile, processImageResponse, IMAGE_PROCESSING_PRESETS } from './image-handler';
import { getVersion } from '../version';
import { SearchResult } from './advanced-search';
import { MCPIgnoreManager } from '../security/mcp-ignore-manager';
import { Debug } from './debug';
import { BasesAPI } from './bases-api';
import {
  BaseFile,
  BaseConfig,
  BaseQueryOptions,
  BaseQueryResult,
  BaseView,
  BaseTemplate,
  BaseExportOptions,
  BaseCapabilities
} from '../types/bases';

export class ObsidianAPI {
  private app: App;
  private config: ObsidianConfig;
  private plugin?: any; // Reference to the plugin for accessing MCP server info
  private ignoreManager?: MCPIgnoreManager;
  private basesAPI: BasesAPI;
  
  constructor(app: App, config?: ObsidianConfig, plugin?: any) {
    this.app = app;
    this.config = config || { apiKey: '', apiUrl: '' };
    this.plugin = plugin;
    this.ignoreManager = plugin?.ignoreManager;
    this.basesAPI = new BasesAPI(app);
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
    const stat = await this.app.vault.adapter.stat(activeFile.path);
    
    return {
      path: activeFile.path,
      content,
      tags: [], // TODO: Extract tags from frontmatter/content
      frontmatter: {} // TODO: Parse frontmatter
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

  async patchActiveFile(params: any) {
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
    }).sort((a, b) => {
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
    
    return {
      path: file.path,
      content,
      tags: [], // TODO: Extract tags from frontmatter/content
      frontmatter: {} // TODO: Parse frontmatter
    };
  }

  async createFile(path: string, content: string) {
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
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    const existingContent = await this.app.vault.read(file);
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
      case 'append':
        // Add content at the end of the section
        lines.splice(endLineIndex, 0, '', patchContent);
        break;
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
    includeContent: boolean = true
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
    if (!query || query.trim().length === 0) {
      return {
        query,
        page,
        pageSize,
        totalResults: 0,
        totalPages: 0,
        results: [],
        method: 'native'
      };
    }

    // Try to access internal search API first, then fallback to our implementation
    try {
      const searchResults = await this.tryInternalSearch(query);
      if (searchResults && searchResults.length > 0) {
        // Process internal search results
        const processedResults = await this.processNativeSearchResults(searchResults, query, strategy, includeContent);
        const paginatedResponse = paginateResults(processedResults, page, pageSize);
        
        return {
          query,
          page: paginatedResponse.page,
          pageSize: paginatedResponse.pageSize,
          totalResults: paginatedResponse.totalResults,
          totalPages: paginatedResponse.totalPages,
          results: paginatedResponse.results,
          method: `internal-${strategy}`,
          ...(paginatedResponse.truncated && {
            truncated: true,
            originalCount: paginatedResponse.originalCount,
            message: paginatedResponse.message
          })
        };
      }
    } catch (error) {
      console.warn('Internal search failed, using official API:', error);
    }

    // Fallback to our official API implementation
    const searchResults = await this.performVaultSearch(query, strategy, includeContent);
    console.log(`Search found ${searchResults.length} results for query: ${query}`);
    if (searchResults.length > 0) {
      console.log('First few results:', searchResults.slice(0, 3).map(r => ({ path: r.path, score: r.score })));
    }
    
    // Apply pagination
    const paginatedResponse = paginateResults(searchResults, page, pageSize);
    console.log(`After pagination: ${paginatedResponse.results.length} results shown, ${paginatedResponse.totalResults} total`);
    
    const response: {
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
    } = {
      query,
      page: paginatedResponse.page,
      pageSize: paginatedResponse.pageSize,
      totalResults: paginatedResponse.totalResults,
      totalPages: paginatedResponse.totalPages,
      results: paginatedResponse.results,
      method: `native-${strategy}`,
      ...(paginatedResponse.truncated && {
        truncated: true,
        originalCount: paginatedResponse.originalCount,
        message: paginatedResponse.message
      })
    };
    
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
      
      // Add pagination suggestion only for first few pages (later pages have lower relevance)
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

  /**
   * Try to access Obsidian's internal search API
   */
  private async tryInternalSearch(query: string): Promise<any[] | null> {
    // Check if app has a search method directly
    if ((this.app as any).search) {
      console.log('Found app.search method');
      return (this.app as any).search(query);
    }

    // Try internal plugins
    const internalPlugins = (this.app as any).internalPlugins;
    if (internalPlugins) {
      console.log('Available internal plugins:', Object.keys(internalPlugins.plugins || {}));
      
      // Try different plugin names
      const searchPluginNames = ['global-search', 'search', 'core-search', 'file-search'];
      for (const name of searchPluginNames) {
        const plugin = internalPlugins.plugins?.[name];
        if (plugin?.instance?.search) {
          console.log(`Found search method in ${name} plugin`);
          return plugin.instance.search(query);
        }
        if (plugin?.instance?.searchIndex?.search) {
          console.log(`Found searchIndex.search in ${name} plugin`);
          return plugin.instance.searchIndex.search(query);
        }
      }
    }

    // Try workspace search
    if ((this.app as any).workspace?.search) {
      console.log('Found workspace.search method');
      return (this.app as any).workspace.search(query);
    }

    console.log('No internal search API found');
    return null;
  }

  /**
   * Perform vault search using official Obsidian API
   */
  private async performVaultSearch(
    query: string,
    strategy: string,
    includeContent: boolean
  ): Promise<SearchResult[]> {
    const searchTerm = this.parseSearchQuery(query);
    const allFiles = this.app.vault.getFiles();
    
    // Filter out excluded files before searching
    const files = this.ignoreManager ? 
      allFiles.filter(file => !this.ignoreManager!.isExcluded(file.path)) : 
      allFiles;
    
    const results: SearchResult[] = [];

    for (const file of files) {
      const matchResult = await this.checkFileMatch(file, searchTerm, includeContent);
      if (matchResult) {
        results.push(matchResult);
      }
    }

    // Sort by relevance score
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Extract quoted phrases from a search string
   */
  private extractQuotedPhrases(text: string): { phrases: string[], remaining: string } {
    const phrases: string[] = [];
    let remaining = text;
    
    // Match quoted strings, handling escaped quotes
    const quoteRegex = /"([^"\\]*(\\.[^"\\]*)*)"/g;
    let match;
    
    while ((match = quoteRegex.exec(text)) !== null) {
      phrases.push(match[1]);
      remaining = remaining.replace(match[0], `__PHRASE_${phrases.length - 1}__`);
    }
    
    return { phrases, remaining };
  }

  /**
   * Parse search query to handle operators like file:, path:, content:
   */
  private parseSearchQuery(query: string): {
    type: 'filename' | 'path' | 'content' | 'tag' | 'general';
    term: string;
    originalQuery: string;
    isRegex?: boolean;
    regex?: RegExp;
    isOr?: boolean;
    orTerms?: string[];
  } {
    const trimmed = query.trim();
    
    // Check for regex pattern /pattern/flags
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
      const lastSlash = trimmed.lastIndexOf('/');
      const pattern = trimmed.substring(1, lastSlash);
      const flags = trimmed.substring(lastSlash + 1);
      try {
        const regex = new RegExp(pattern, flags);
        return { type: 'general', term: pattern, originalQuery: query, isRegex: true, regex };
      } catch (e) {
        // Invalid regex, treat as normal search
        console.warn('Invalid regex pattern:', e);
      }
    }
    
    // Check for operators
    if (trimmed.startsWith('file:')) {
      return { type: 'filename', term: trimmed.substring(5).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('path:')) {
      return { type: 'path', term: trimmed.substring(5).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('content:')) {
      return { type: 'content', term: trimmed.substring(8).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('tag:')) {
      return { type: 'tag', term: trimmed.substring(4).trim(), originalQuery: query };
    }
    
    // Check for OR operator (handle quoted phrases)
    if (trimmed.includes(' OR ')) {
      const { phrases, remaining } = this.extractQuotedPhrases(trimmed);
      
      // Split on OR, then restore phrases
      const orParts = remaining.split(' OR ').map(part => {
        let restored = part.trim();
        phrases.forEach((phrase, i) => {
          restored = restored.replace(`__PHRASE_${i}__`, phrase);
        });
        return restored;
      });
      
      return { type: 'general', term: trimmed, originalQuery: query, isOr: true, orTerms: orParts };
    }
    
    // Check for quoted phrases in single terms
    const { phrases } = this.extractQuotedPhrases(trimmed);
    if (phrases.length === 1 && trimmed === `"${phrases[0]}"`) {
      // Single quoted phrase
      return { type: 'general', term: phrases[0], originalQuery: query };
    }
    
    return { type: 'general', term: trimmed, originalQuery: query };
  }

  /**
   * Check if a file matches the search criteria
   */
  private async checkFileMatch(
    file: TFile,
    searchTerm: { type: string; term: string; originalQuery: string; isRegex?: boolean; regex?: RegExp; isOr?: boolean; orTerms?: string[] },
    includeContent: boolean
  ): Promise<SearchResult | null> {
    const termLower = searchTerm.term.toLowerCase();
    let score = 0;
    let snippet = undefined;

    // Helper function to check if text matches the search term
    const textMatches = (text: string): boolean => {
      if (searchTerm.isOr && searchTerm.orTerms) {
        // Check if any of the OR terms match
        return searchTerm.orTerms.some(term => 
          text.toLowerCase().includes(term.toLowerCase())
        );
      }
      if (searchTerm.isRegex && searchTerm.regex) {
        return searchTerm.regex.test(text);
      }
      return text.toLowerCase().includes(termLower);
    };

    switch (searchTerm.type) {
      case 'filename': {
        // Support searching by extension (e.g., file:.png)
        const fileName = file.name.toLowerCase();
        const baseName = file.basename.toLowerCase();
        
        if (termLower.startsWith('.')) {
          // Extension search
          if (fileName.endsWith(termLower)) {
            score = 1.5;
          }
        } else {
          // Regular filename search
          if (baseName.includes(termLower)) {
            score = baseName === termLower ? 2.0 : 1.0;
          } else if (fileName.includes(termLower)) {
            score = 0.8; // Lower score for extension matches
          }
        }
        break;
      }
        
      case 'path':
        if (file.path.toLowerCase().includes(termLower)) {
          score = file.path.toLowerCase() === termLower ? 2.0 : 1.0;
        }
        break;
        
      case 'content':
        if (this.isTextFile(file)) {
          try {
            const content = await this.app.vault.read(file);
            if (content.toLowerCase().includes(termLower)) {
              score = 1.0;
              if (includeContent) {
                snippet = this.extractSnippet(content, searchTerm.term, 200);
              }
            }
          } catch (error) {
            // Skip files that can't be read
          }
        }
        break;
        
      case 'tag':
        if (this.isTextFile(file)) {
          try {
            const cache = this.app.metadataCache.getFileCache(file);
            const tags = cache ? (getAllTags(cache) || []) : [];

            if (tags.length > 0) {
              // Normalize the search term to include leading '#'
              const target = termLower.startsWith('#') ? termLower : `#${termLower}`;
              const tagMatch = tags.some((t) => {
                const tl = String(t).toLowerCase();
                // Match exact tag or hierarchical descendants (e.g., #foo or #foo/bar)
                return tl === target || tl.startsWith(`${target}/`);
              });
              if (tagMatch) {
                score = 1.0;
              }
            }
          } catch (error) {
            // Skip if metadata unavailable
          }
        }
        break;
        
      case 'general':
        // Check filename first (including extension for regex matching)
        if (textMatches(file.name) || textMatches(file.basename)) {
          score = 1.5;
        }
        // Check content for text files
        if (this.isTextFile(file)) {
          try {
            const content = await this.app.vault.read(file);
            if (textMatches(content)) {
              score = Math.max(score, 1.0);
              if (includeContent) {
                snippet = this.extractSnippet(content, searchTerm.term, 200);
              }
            }
          } catch (error) {
            // Skip files that can't be read
          }
        }
        break;
    }

    if (score > 0) {
      return {
        path: file.path,
        title: file.basename,
        score,
        snippet,
        metadata: {
          size: file.stat.size,
          modified: file.stat.mtime,
          extension: file.extension
        }
      };
    }

    return null;
  }

  /**
   * Process native Obsidian search results and add our special processing
   */
  private async processNativeSearchResults(
    nativeResults: any[],
    query: string,
    strategy: string,
    includeContent: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    for (const nativeResult of nativeResults) {
      try {
        // Native results typically have: file, score, matches
        const file = nativeResult.file;
        if (!file) continue;
        
        const result: SearchResult = {
          path: file.path,
          title: file.basename,
          score: nativeResult.score || 1.0,
          metadata: {
            size: file.stat?.size || 0,
            modified: file.stat?.mtime || 0,
            extension: file.extension || ''
          }
        };
        
        // Add snippets for text files if requested
        if (includeContent && this.isTextFile(file)) {
          try {
            const content = await this.app.vault.read(file);
            const snippet = this.extractSnippet(content, query, 200);
            if (snippet) {
              result.snippet = snippet;
            }
          } catch (error) {
            // If we can't read the file, skip snippet generation
            console.warn(`Could not read file for snippet: ${file.path}`, error);
          }
        }
        
        results.push(result);
      } catch (error) {
        console.warn('Error processing native search result:', error);
        continue;
      }
    }
    
    return results;
  }

  /**
   * Extract a snippet around query matches
   */
  private extractSnippet(
    content: string, 
    query: string, 
    maxLength: number
  ): { content: string; lineStart: number; lineEnd: number; score: number } | undefined {
    const lines = content.split('\n');
    const queryLower = query.toLowerCase();
    
    // Find the first line that contains the query
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 2);
        const snippetLines = lines.slice(start, end + 1);
        const snippetContent = snippetLines.join('\n');
        
        // Truncate if too long
        const truncated = snippetContent.length > maxLength 
          ? snippetContent.substring(0, maxLength) + '...'
          : snippetContent;
        
        return {
          content: truncated,
          lineStart: start + 1,
          lineEnd: end + 1,
          score: 1.0
        };
      }
    }
    
    return undefined;
  }

  // Obsidian integration
  async openFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    const leaf = this.app.workspace.getUnpinnedLeaf();
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
          console.log(`${operationType} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms... Error: ${error.message}`);
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
   * Check if Bases functionality is available
   */
  async getBasesCapabilities(): Promise<BaseCapabilities> {
    return await this.basesAPI.getCapabilities();
  }

  /**
   * List all bases in the vault
   */
  async listBases(): Promise<BaseFile[]> {
    return await this.basesAPI.listBases();
  }

  /**
   * Get a specific base by path
   */
  async getBase(path: string): Promise<BaseFile> {
    return await this.basesAPI.getBase(path);
  }

  /**
   * Create a new base from configuration
   */
  async createBase(config: BaseConfig): Promise<BaseFile> {
    return await this.basesAPI.createBase(config);
  }

  /**
   * Update an existing base configuration
   */
  async updateBase(path: string, config: Partial<BaseConfig>): Promise<void> {
    return await this.basesAPI.updateBase(path, config);
  }

  /**
   * Delete a base
   */
  async deleteBase(path: string): Promise<void> {
    return await this.basesAPI.deleteBase(path);
  }

  /**
   * Query a base with filters and options
   */
  async queryBase(path: string, options?: BaseQueryOptions): Promise<BaseQueryResult> {
    return await this.basesAPI.queryBase(path, options);
  }

  /**
   * Get a specific view of a base
   */
  async getBaseView(path: string, viewName: string): Promise<BaseView> {
    return await this.basesAPI.getBaseView(path, viewName);
  }

  /**
   * Generate a note from base template
   */
  async generateFromBaseTemplate(basePath: string, template: BaseTemplate): Promise<TFile> {
    return await this.basesAPI.generateFromTemplate(basePath, template);
  }

  /**
   * Export base data in specified format
   */
  async exportBase(path: string, options: BaseExportOptions): Promise<string> {
    return await this.basesAPI.exportBase(path, options);
  }

}