/**
 * State token system for semantic hints - inspired by Petri nets
 * Tokens represent available states/resources that enable certain actions
 */

export interface StateTokens {
  // File tokens
  file_loaded?: string;           // Path of currently loaded file
  file_content?: boolean;         // File content is available
  file_has_links?: string[];      // Links found in current file
  file_has_tags?: string[];       // Tags found in current file
  file_is_markdown?: boolean;     // Current file is markdown
  
  // Buffer tokens  
  buffer_available?: boolean;     // Content buffer has data
  buffer_file?: string;          // Which file the buffer is for
  buffer_search_text?: string;   // What was searched for
  
  // Search tokens
  search_performed?: boolean;     // A search was done
  search_query?: string;         // Last search query
  search_has_results?: boolean;  // Search returned results
  search_result_count?: number;  // Number of results
  search_result_paths?: string[]; // Paths of search results
  
  // Directory tokens
  directory_listed?: string;     // Last directory listed
  directory_has_files?: boolean; // Directory contains files
  directory_file_list?: string[]; // Files in directory
  
  // Edit tokens
  edit_in_progress?: boolean;    // Currently editing
  edit_target_file?: string;     // File being edited
  edit_success_count?: number;   // Successful edits in session
  
  // Navigation tokens
  file_history?: string[];       // Files visited
  directory_history?: string[];  // Directories visited
  
  // System tokens
  obsidian_available?: boolean;  // Can open in Obsidian
  web_content_available?: boolean; // Fetched web content
}

export class StateTokenManager {
  private tokens: StateTokens = {};
  
  /**
   * Update tokens based on operation results
   */
  updateTokens(operation: string, action: string, params: unknown, result: unknown, success: boolean) {
    switch (operation) {
      case 'vault':
        this.updateVaultTokens(action, params, result, success);
        break;
      case 'edit':
        this.updateEditTokens(action, params, result, success);
        break;
      case 'view':
        this.updateViewTokens(action, params, result, success);
        break;
      case 'search':
        this.updateSearchTokens(action, params, result, success);
        break;
    }
  }
  
  private updateVaultTokens(action: string, params: any, result: any, success: boolean) {
    if (!success) return;
    
    switch (action) {
      case 'read':
        this.tokens.file_loaded = params.path;
        this.tokens.file_content = true;
        this.tokens.file_is_markdown = params.path?.endsWith('.md');

        // Extract links and tags from result
        if (typeof result === 'object') {
          // Use tags from API response (includes frontmatter tags from metadataCache)
          if (result.tags && Array.isArray(result.tags)) {
            this.tokens.file_has_tags = result.tags;
          } else if (result.content) {
            // Fallback to content extraction
            this.tokens.file_has_tags = this.extractTags(result.content);
          }

          // Extract links from content
          if (result.content) {
            this.tokens.file_has_links = this.extractLinks(result.content);
          }
        }
        
        // Update history
        this.addToFileHistory(params.path);
        break;
        
      case 'list':
        this.tokens.directory_listed = params.directory || '/';
        this.tokens.directory_file_list = result;
        this.tokens.directory_has_files = result && result.length > 0;
        this.addToDirectoryHistory(params.directory);
        break;
        
      case 'search':
        this.tokens.search_performed = true;
        this.tokens.search_query = params.query;
        this.tokens.search_has_results = result.totalResults > 0;
        this.tokens.search_result_count = result.totalResults;
        this.tokens.search_result_paths = result.results?.map((r: any) => r.path) || [];
        break;
        
      case 'create':
        this.tokens.file_loaded = params.path;
        this.tokens.file_content = true;
        this.tokens.file_is_markdown = params.path?.endsWith('.md');
        this.addToFileHistory(params.path);
        break;
    }
  }
  
  private updateEditTokens(action: string, params: any, result: any, success: boolean) {
    this.tokens.edit_target_file = params.path;
    
    if (success) {
      this.tokens.edit_in_progress = false;
      this.tokens.edit_success_count = (this.tokens.edit_success_count || 0) + 1;
      
      // If edit succeeded, file content may have changed
      if (this.tokens.file_loaded === params.path) {
        this.tokens.file_has_links = undefined;
        this.tokens.file_has_tags = undefined;
      }
    } else {
      this.tokens.edit_in_progress = true;
      
      // Buffer tokens for failed edits
      if (action === 'window') {
        this.tokens.buffer_available = true;
        this.tokens.buffer_file = params.path;
        this.tokens.buffer_search_text = params.oldText;
      }
    }
  }
  
  private updateViewTokens(action: string, params: any, result: any, success: boolean) {
    if (!success) return;
    
    switch (action) {
      case 'file':
      case 'window':
        this.tokens.file_loaded = params.path;
        this.tokens.file_content = true;
        this.addToFileHistory(params.path);
        break;
        
      case 'open_in_obsidian':
        this.tokens.obsidian_available = true;
        break;
    }
  }
  
  private updateSearchTokens(action: string, params: unknown, result: unknown, success: boolean) {
    // Handled in vault tokens
  }
  
  /**
   * Check if required tokens exist for a condition
   */
  hasTokensFor(condition: string): boolean {
    switch (condition) {
      case 'can_edit_file':
        return !!this.tokens.file_loaded && !!this.tokens.file_content;
        
      case 'can_follow_links':
        return !!this.tokens.file_has_links && this.tokens.file_has_links.length > 0;
        
      case 'can_search_tags':
        return !!this.tokens.file_has_tags && this.tokens.file_has_tags.length > 0;
        
      case 'can_use_buffer':
        return !!this.tokens.buffer_available && !!this.tokens.buffer_file;
        
      case 'can_refine_search':
        return !!this.tokens.search_performed && !!this.tokens.search_query;
        
      case 'can_read_search_results':
        return !!this.tokens.search_has_results && 
               !!this.tokens.search_result_paths && 
               this.tokens.search_result_paths.length > 0;
               
      case 'can_navigate_directory':
        return !!this.tokens.directory_has_files && 
               !!this.tokens.directory_file_list &&
               this.tokens.directory_file_list.some(f => f.endsWith('.md'));
               
      case 'can_continue_editing':
        return !!this.tokens.edit_target_file && 
               (this.tokens.edit_success_count || 0) > 0;
               
      case 'has_file_history':
        return !!this.tokens.file_history && this.tokens.file_history.length > 1;
        
      default:
        return true; // Unknown conditions pass by default
    }
  }
  
  /**
   * Get current tokens for context
   */
  getTokens(): StateTokens {
    return { ...this.tokens };
  }
  
  /**
   * Clear specific tokens
   */
  clearTokens(tokenNames: string[]) {
    for (const name of tokenNames) {
      delete (this.tokens as any)[name];
    }
  }
  
  private extractLinks(content: string): string[] {
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const links: string[] = [];
    let match;
    
    while ((match = linkRegex.exec(content)) !== null) {
      links.push(match[1]);
    }
    
    return links;
  }
  
  private extractTags(content: string): string[] {
    const tagRegex = /#[\w-]+/g;
    const tags: string[] = [];
    let match;
    
    while ((match = tagRegex.exec(content)) !== null) {
      tags.push(match[0]);
    }
    
    return [...new Set(tags)]; // Remove duplicates
  }
  
  private addToFileHistory(path: string) {
    if (!this.tokens.file_history) {
      this.tokens.file_history = [];
    }
    
    // Remove if already exists and add to end
    this.tokens.file_history = this.tokens.file_history.filter(p => p !== path);
    this.tokens.file_history.push(path);
    
    // Keep last 10
    if (this.tokens.file_history.length > 10) {
      this.tokens.file_history = this.tokens.file_history.slice(-10);
    }
  }
  
  private addToDirectoryHistory(path: string) {
    if (!this.tokens.directory_history) {
      this.tokens.directory_history = [];
    }
    
    this.tokens.directory_history = this.tokens.directory_history.filter(p => p !== path);
    this.tokens.directory_history.push(path);
    
    if (this.tokens.directory_history.length > 5) {
      this.tokens.directory_history = this.tokens.directory_history.slice(-5);
    }
  }
}