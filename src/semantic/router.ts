import { Debug } from '../utils/debug';
import { ObsidianAPI } from '../utils/obsidian-api';
import {
  SemanticResponse,
  WorkflowConfig,
  SemanticContext,
  SemanticRequest,
  SuggestedAction
} from '../types/semantic';
import { ContentBufferManager } from '../utils/content-buffer';
import { StateTokenManager } from './state-tokens';
import { limitResponse } from '../utils/response-limiter';
import { isImageFile } from '../types/obsidian';
import { UniversalFragmentRetriever } from '../indexing/fragment-retriever';
import { readFileWithFragments } from '../utils/file-reader';
import { GraphSearchTool } from '../tools/graph-search';
import { GraphSearchTool as GraphSearchTraversalTool } from '../tools/graph-search-tool';
import { GraphTagTool } from '../tools/graph-tag-tool';
import { App } from 'obsidian';
import { InputValidator, ValidationException } from '../validation/input-validator';

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
      
    } catch (error: any) {
      // Update tokens for failure
      this.tokenManager.updateTokens(operation, action, params, null, false);
      
      // Handle errors with semantic recovery hints
      return this.handleError(error, operation, action, params);
    }
  }
  
  private async executeOperation(operation: string, action: string, params: any): Promise<any> {
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
  
  private async executeVaultOperation(action: string, params: any): Promise<any> {
    switch (action) {
      case 'list': {
        // Translate "/" to undefined for root directory
        const directory = params.directory === '/' ? undefined : params.directory;
        
        // Use paginated list if page parameters are provided
        if (params.page || params.pageSize) {
          const page = parseInt(params.page) || 1;
          const pageSize = parseInt(params.pageSize) || 20;
          return await this.api.listFilesPaginated(directory, page, pageSize);
        }
        
        // Fallback to simple list for backwards compatibility
        return await this.api.listFiles(directory);
      }
      case 'read':
        return await readFileWithFragments(this.api, this.fragmentRetriever, {
          path: params.path,
          returnFullFile: params.returnFullFile,
          query: params.query,
          strategy: params.strategy,
          maxFragments: params.maxFragments
        });
      case 'fragments': {
        // Dedicated fragment search across multiple files
        const fragmentQuery = params.query || params.path || '';

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
            strategy: params.strategy || 'auto',
            maxFragments: params.maxFragments || 5
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
        return await this.api.createFile(params.path, params.content || '');
      case 'update':
        return await this.api.updateFile(params.path, params.content);
      case 'delete':
        return await this.api.deleteFile(params.path);
      case 'search': {
        // Validate query
        if (!params.query || params.query.trim().length === 0) {
          return {
            query: params.query || '',
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
          const page = parseInt(params.page) || 1;
          const pageSize = parseInt(params.pageSize) || 10;
          // Use searchStrategy for search, fall back to strategy for backward compatibility
          const strategy = params.searchStrategy || params.strategy || 'combined';
          const includeContent = params.includeContent !== false; // Default to true

          // Build search options from new parameters
          const searchOptions: {
            ranked?: boolean;
            includeSnippets?: boolean;
            snippetLength?: number;
          } = {};

          if (params.ranked !== undefined) {
            searchOptions.ranked = params.ranked;
          }
          if (params.includeSnippets !== undefined) {
            searchOptions.includeSnippets = params.includeSnippets;
          }
          if (params.snippetLength !== undefined) {
            searchOptions.snippetLength = parseInt(params.snippetLength);
          }

          const searchResults = await this.api.searchPaginated(
            params.query,
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
              params.query,
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
            query: params.query,
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
        const { path, destination, overwrite = false } = params;
        
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
        } catch (e) {
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
        const { path, newName, overwrite = false } = params;
        
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
        } catch (e) {
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
        const { path, destination, overwrite = false } = params;
        
        if (!path || !destination) {
          throw new Error('Both path and destination are required for copy operation');
        }
        
        // First try as a file (this will go through security validation)
        try {
          const sourceFile = await this.api.getFile(path);
          return await this.copyFile(path, destination, overwrite, sourceFile);
        } catch (fileError: any) {
          // If file operation failed, try as directory (this will also go through security validation)
          try {
            // Test if it's a directory by trying to list its contents
            await this.api.listFiles(path);
            // If listing succeeds, it's a directory
            return await this.copyDirectoryRecursive(path, destination, overwrite);
          } catch (dirError: any) {
            // Neither file nor directory worked
            throw new Error(`Source not found or inaccessible: ${path}`);
          }
        }
      }
      
      case 'split': {
        const { path, splitBy, delimiter, level, linesPerFile, maxSize, outputPattern, outputDirectory } = params;
        
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
        const { paths, destination, separator = '\n\n---\n\n', includeFilenames = false, overwrite = false, sortBy, sortOrder = 'asc' } = params;

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
        } catch (e) {
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
        const { path1, path2, destination, mode = 'append' } = params;
        
        if (!path1 || !path2) {
          throw new Error('Both path1 and path2 are required for concatenate operation');
        }
        
        // Determine paths and destination based on mode
        const paths = mode === 'prepend' ? [path2, path1] : [path1, path2];
        const dest = destination || (mode === 'new' ? `${path1}-concatenated` : path1);
        
        // Use combine operation internally
        return this.executeVaultOperation('combine', {
          paths,
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
  
  private combineSearchResults(apiResults: any[], fallbackResults: any[]): any[] {
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
  
  private async splitContent(content: string, params: any): Promise<Array<{ content: string }>> {
    const { splitBy, delimiter, level, linesPerFile, maxSize } = params;
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
  private async copyFile(path: string, destination: string, overwrite: boolean, sourceFile: any): Promise<any> {
    // Check if destination already exists
    try {
      const destFile = await this.api.getFile(destination);
      if (destFile && !overwrite) {
        throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
      }
    } catch (e: any) {
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
  private async copyDirectoryRecursive(sourcePath: string, destPath: string, overwrite: boolean): Promise<any> {
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
              } catch (e: any) {
                // File doesn't exist - good to proceed
                if (!e.message?.includes('Destination exists')) {
                  // Some other error occurred, but continue
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
          } catch (error: any) {
            if (error.message?.includes('Destination exists')) {
              throw error; // Re-throw destination exists errors
            }
            // Log other errors but continue
            Debug.warn(`Failed to copy ${srcPath}: ${error.message}`);
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
  
  private getSearchWorkflowHints(results: any[]): any {
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
  
  private async performFileBasedSearch(query: string, page: number, pageSize: number, includeContent: boolean = false): Promise<any> {
    const lowerQuery = query.toLowerCase();
    const allResults: any[] = [];
    
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
  
  private async executeEditOperation(action: string, params: any): Promise<any> {
    // Import window edit tools dynamically to avoid circular dependencies
    const { performWindowEdit } = await import('../tools/window-edit.js');
    const buffer = ContentBufferManager.getInstance();
    
    switch (action) {
      case 'window': {
        const result = await performWindowEdit(
          this.api,
          params.path,
          params.oldText,
          params.newText,
          params.fuzzyThreshold
        );
        if (result.isError) {
          throw new Error(result.content[0].text);
        }
        return result;
      }
      case 'append':
        return await this.api.appendToFile(params.path, params.content);
      case 'patch':
        return await this.api.patchVaultFile(params.path, {
          operation: params.operation,
          targetType: params.targetType,
          target: params.target,
          content: params.content,
          old_text: params.oldText,
          new_text: params.newText
        });
      case 'at_line': {
        // Get content to insert
        let insertContent = params.content;
        if (!insertContent) {
          const buffered = buffer.retrieve();
          if (!buffered) {
            throw new Error('No content provided and no buffered content found');
          }
          insertContent = buffered.content;
        }
        
        // Get file and perform line-based edit
        const file = await this.api.getFile(params.path);
        if (isImageFile(file)) {
          throw new Error('Cannot perform line-based edits on image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');
        
        if (params.lineNumber < 1 || params.lineNumber > lines.length + 1) {
          throw new Error(`Invalid line number ${params.lineNumber}. File has ${lines.length} lines.`);
        }
        
        const lineIndex = params.lineNumber - 1;
        const mode = params.mode || 'replace';
        
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
        
        await this.api.updateFile(params.path, lines.join('\n'));
        return { success: true, line: params.lineNumber, mode };
      }
      case 'from_buffer': {
        const buffered = buffer.retrieve();
        if (!buffered) {
          throw new Error('No buffered content available');
        }
        return await performWindowEdit(
          this.api,
          params.path,
          params.oldText || buffered.searchText || '',
          buffered.content,
          params.fuzzyThreshold
        );
      }
      default:
        throw new Error(`Unknown edit action: ${action}`);
    }
  }
  
  private async executeViewOperation(action: string, params: any): Promise<any> {
    switch (action) {
      case 'file':
        return await this.api.getFile(params.path);
      case 'window': {
        // View a portion of a file
        const file = await this.api.getFile(params.path);
        if (isImageFile(file)) {
          throw new Error('Cannot view window of image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');
        
        let centerLine = params.lineNumber || 1;
        
        // If search text provided, find it
        if (params.searchText && !params.lineNumber) {
          const { findFuzzyMatches } = await import('../utils/fuzzy-match.js');
          const matches = findFuzzyMatches(content, params.searchText, 0.6);
          if (matches.length > 0) {
            centerLine = matches[0].lineNumber;
          }
        }
        
        // Calculate window
        const windowSize = params.windowSize || 20;
        const halfWindow = Math.floor(windowSize / 2);
        const startLine = Math.max(1, centerLine - halfWindow);
        const endLine = Math.min(lines.length, centerLine + halfWindow);
        
        return {
          path: params.path,
          lines: lines.slice(startLine - 1, endLine),
          startLine,
          endLine,
          totalLines: lines.length,
          centerLine,
          searchText: params.searchText
        };
      }
        
      case 'active':
        // Add timeout to prevent hanging when no file is active
        try {
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout: No active file in Obsidian. Please open a file first.')), 5000)
          );
          const result = await Promise.race([
            this.api.getActiveFile(),
            timeoutPromise
          ]);
          return result;
        } catch (error: any) {
          if (error.message.includes('Timeout')) {
            throw error;
          }
          // Re-throw original error if not timeout
          throw error;
        }
        
      case 'open_in_obsidian':
        return await this.api.openFile(params.path);
        
      default:
        throw new Error(`Unknown view action: ${action}`);
    }
  }
  
  private async executeWorkflowOperation(action: string, params: any): Promise<any> {
    switch (action) {
      case 'suggest':
        return this.generateWorkflowSuggestions();
      default:
        throw new Error(`Unknown workflow action: ${action}`);
    }
  }
  
  private async executeSystemOperation(action: string, params: any): Promise<any> {
    switch (action) {
      case 'info':
        return await this.api.getServerInfo();
      case 'commands':
        return await this.api.getCommands();
      case 'fetch_web': {
        // Import fetch tool dynamically
        const { fetchTool } = await import('../tools/fetch.js');
        return await fetchTool.handler(this.api, params);
      }
      default:
        throw new Error(`Unknown system action: ${action}`);
    }
  }
  
  private async executeGraphOperation(action: string, params: any): Promise<any> {
    // Handle graph search traversal operations
    if (action === 'search-traverse' || action === 'advanced-traverse') {
      if (!this.graphSearchTraversalTool) {
        throw new Error('Graph search traversal operations require Obsidian app context');
      }
      return await this.graphSearchTraversalTool.execute({
        action,
        ...params
      });
    }
    
    // Handle tag-based graph operations
    if (action === 'tag-traverse' || action === 'tag-analysis' || action === 'shared-tags') {
      if (!this.graphTagTool) {
        throw new Error('Graph tag operations require Obsidian app context');
      }
      return await this.graphTagTool.execute({
        action,
        ...params
      });
    }
    
    // Handle standard graph operations
    if (!this.graphSearchTool) {
      throw new Error('Graph operations require Obsidian app context');
    }
    
    // Map action to graph operation
    const graphParams = {
      ...params,
      operation: action
    };
    
    return await this.graphSearchTool.search(graphParams);
  }
  
  private enrichResponse(result: any, operation: string, action: string, params: any, isError: boolean): SemanticResponse {
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
  
  private interpolateMessage(template: string, params: any, result: any): string {
    return template.replace(/{(\w+)}/g, (match, key) => {
      return params?.[key] || result?.[key] || match;
    });
  }
  
  private generateSuggestions(conditionalSuggestions: any[], params: any, result: any): SuggestedAction[] {
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
  
  private evaluateCondition(condition: string, params: any, result: any): boolean {
    switch (condition) {
      case 'always':
        return true;
      case 'has_results':
        return result && (result.results?.length > 0 || result.totalResults > 0);
      case 'no_results':
        return !result || (result.results?.length === 0 && result.totalResults === 0);
      case 'has_links':
        return result?.links?.length > 0;
      case 'has_tags':
        return result?.tags?.length > 0;
      case 'has_markdown_files':
        return Array.isArray(result) && result.some(f => f.endsWith('.md'));
      case 'is_daily_note':
        return this.matchesPattern(params.path, this.config.context_triggers?.daily_note_pattern);
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
  
  private checkEfficiencyRules(operation: string, action: string, params: any): any[] {
    if (!this.config.efficiency_rules) return [];
    
    const matches = [];
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
  
  private updateContext(operation: string, action: string, params: any) {
    this.context.operation = operation;
    this.context.action = action;
    
    if (params.path) {
      this.context.last_file = params.path;
      
      // Track file history
      if (!this.context.file_history) {
        this.context.file_history = [];
      }
      if (!this.context.file_history.includes(params.path)) {
        this.context.file_history.push(params.path);
        // Keep only last 10 files
        if (this.context.file_history.length > 10) {
          this.context.file_history.shift();
        }
      }
    }
    
    if (params.directory) {
      this.context.last_directory = params.directory;
    }
    
    if (params.query) {
      if (!this.context.search_history) {
        this.context.search_history = [];
      }
      this.context.search_history.push(params.query);
      // Keep only last 5 searches
      if (this.context.search_history.length > 5) {
        this.context.search_history.shift();
      }
    }
  }
  
  private updateContextAfterSuccess(response: SemanticResponse, params: any) {
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
  
  private handleError(error: any, operation: string, action: string, params: any): SemanticResponse {
    const errorResponse = this.enrichResponse(
      null,
      operation,
      action,
      params,
      true // isError
    );
    
    // Extract parent directory from the directory parameter for suggestions
    if (operation === 'vault' && action === 'list' && params.directory) {
      const parts = params.directory.split('/');
      if (parts.length > 1) {
        parts.pop();
        params.parent_directory = parts.join('/') || undefined;
      }
    }
    
    errorResponse.error = {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      recovery_hints: errorResponse.workflow?.suggested_next
    };
    
    delete errorResponse.workflow; // Move suggestions to recovery_hints
    
    return errorResponse;
  }
  
  private generateWorkflowSuggestions(): any {
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
  private generateEnhancedSemanticHints(operation: string, action: string, params: any, result: any): { message: string; suggested_next: SuggestedAction[] } | null {
    const suggestions: SuggestedAction[] = [];
    let message = '';

    // Enhanced hints for search operations
    if (operation === 'vault' && action === 'search') {
      if (result?.results && Array.isArray(result.results) && result.results.length > 0) {
        message = 'Consider exploring connections between these files using graph operations.';
        
        // Get first few results for graph exploration suggestions
        const firstResult = result.results[0];
        const hasMultipleResults = result.results.length > 1;
        
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
          const secondResult = result.results[1];
          if (secondResult?.path && firstResult?.path) {
            suggestions.push({
              description: 'Find connection path between top results',
              command: `graph(action='path', sourcePath='${firstResult.path}', targetPath='${secondResult.path}')`,
              reason: 'Discover how these search results are connected'
            });
          }
        }
        
        // Tag-based exploration if we detect potential tag-related content
        if (params.query && params.query.includes('#')) {
          const tagQuery = params.query.replace('#', '');
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
      if (params.path && !result?.error) {
        message = 'Explore connections and references for deeper context.';
        
        suggestions.push({
          description: 'Explore graph connections from this file',
          command: `graph(action='neighbors', sourcePath='${params.path}')`,
          reason: 'Find directly connected files'
        });
        
        suggestions.push({
          description: 'Find files that reference this one',
          command: `graph(action='backlinks', sourcePath='${params.path}')`,
          reason: 'See where this file is mentioned or linked'
        });
        
        // Check if the content suggests it might have many connections
        const content = typeof result === 'string' ? result : result?.content || '';
        
        // Safely count links and tags, handling both string content and Fragment arrays
        let linkCount = 0;
        let tagCount = 0;
        
        if (typeof content === 'string') {
          linkCount = (content.match(/\[\[.*?\]\]/g) || []).length;
          tagCount = (content.match(/#\w+/g) || []).length;
        } else if (Array.isArray(content)) {
          // Handle Fragment[] - extract content from each fragment
          content.forEach(fragment => {
            const fragmentText = typeof fragment === 'string' ? fragment : 
                                (fragment?.content || fragment?.text || fragment?.data || '');
            if (typeof fragmentText === 'string' && fragmentText.length > 0) {
              linkCount += (fragmentText.match(/\[\[.*?\]\]/g) || []).length;
              tagCount += (fragmentText.match(/#\w+/g) || []).length;
            }
          });
        }
        
        if (linkCount > 2) {
          suggestions.push({
            description: 'Traverse the link network from this file',
            command: `graph(action='traverse', sourcePath='${params.path}', maxDepth=3)`,
            reason: `This file has ${linkCount} links - explore the broader network`
          });
        }
        
        if (tagCount > 0) {
          suggestions.push({
            description: 'Find files with similar tags',
            command: `graph(action='tag-traverse', startPath='${params.path}', maxDepth=2)`,
            reason: `This file has ${tagCount} tags - explore related content`
          });
        }
      }
    }
    
    // Enhanced hints for list operations - suggest exploring discovered files
    if (operation === 'vault' && action === 'list') {
      if (result && Array.isArray(result) && result.length > 1) {
        message = 'Consider exploring relationships between these files.';
        
        const mdFiles = result.filter(f => typeof f === 'string' && f.endsWith('.md'));
        if (mdFiles.length >= 2) {
          suggestions.push({
            description: 'Find connections between files in this directory',
            command: `graph(action='path', sourcePath='${mdFiles[0]}', targetPath='${mdFiles[1]}')`,
            reason: 'Discover how files in this directory relate to each other'
          });
          
          suggestions.push({
            description: 'Analyze tag relationships in this directory',
            command: `graph(action='tag-analysis', folderFilter='${params.directory || '/'}')`,
            reason: 'Find common themes and tags among these files'
          });
        }
      } else if (result && typeof result === 'object' && result.files && Array.isArray(result.files)) {
        // Handle paginated results
        const mdFiles = result.files.filter((f: any) => f.name && f.name.endsWith('.md'));
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
      if (result?.fragments && result.fragments.length > 0) {
        message = 'Explore connections between documents containing these fragments.';
        
        const sourcePaths = [...new Set(result.fragments.map((f: any) => f.source).filter(Boolean))];
        if (sourcePaths.length >= 2) {
          suggestions.push({
            description: 'Find connections between fragment sources',
            command: `graph(action='path', sourcePath='${sourcePaths[0]}', targetPath='${sourcePaths[1]}')`,
            reason: 'Explore how documents with similar content are connected'
          });
          
          suggestions.push({
            description: 'Traverse network from first fragment source',
            command: `graph(action='traverse', sourcePath='${sourcePaths[0]}', maxDepth=2)`,
            reason: 'Discover the broader context around this content'
          });
        }
      }
    }
    
    return suggestions.length > 0 ? { message, suggested_next: suggestions } : null;
  }

  private async executeBasesOperation(action: string, params: any): Promise<any> {
    switch (action) {
      case 'list':
        return await this.api.listBases();
      
      case 'read':
        if (!params.path) {
          throw new Error('Path parameter is required for reading a base');
        }
        return await this.api.readBase(params.path);
      
      case 'create':
        if (!params.path || !params.config) {
          throw new Error('Path and config parameters are required for creating a base');
        }
        await this.api.createBase(params.path, params.config);
        return { success: true, path: params.path };
      
      case 'query':
        if (!params.path) {
          throw new Error('Path parameter is required for querying a base');
        }
        return await this.api.queryBase(params.path, params.viewName);
      
      case 'view':
        if (!params.path || !params.viewName) {
          throw new Error('Path and viewName parameters are required for getting a base view');
        }
        // View is handled by query with viewName
        return await this.api.queryBase(params.path, params.viewName);
      
      case 'export': {
        if (!params.path || !params.format) {
          throw new Error('Path and format parameters are required for exporting a base');
        }
        const exportData = await this.api.exportBase(params.path, params.format, params.viewName);
        return {
          success: true,
          data: exportData,
          format: params.format
        };
      }
      
      default:
        throw new Error(`Unknown bases action: ${action}`);
    }
  }
}