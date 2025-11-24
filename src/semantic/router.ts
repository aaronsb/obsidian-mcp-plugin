import { Debug } from '../utils/debug';
import { ObsidianAPI } from '../utils/obsidian-api';
import {
  SemanticResponse,
  WorkflowConfig,
  SemanticContext,
  SemanticRequest
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
import { App, TFile } from 'obsidian';

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

  constructor(api: ObsidianAPI, app?: App) {
    this.api = api;
    this.app = app;
    this.tokenManager = new StateTokenManager();
    this.fragmentRetriever = new UniversalFragmentRetriever();
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
      case 'system':
        return this.executeSystemOperation(action, params);
      case 'graph':
        return this.executeGraphOperation(action, params);
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
          returnFullFile: params.returnFullFile ?? true,
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

          return fragmentResponse.result;
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
          const strategy = params.strategy || 'combined'; // filename, content, combined
          const includeContent = params.includeContent !== false; // Default to true

          const searchResults = await this.api.searchPaginated(
            params.query,
            page,
            pageSize,
            strategy,
            includeContent
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
              newPath: destination
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
          newPath: destination
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
              newPath: newPath
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
          newPath: newPath
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
          totalFiles: createdFiles.length
        };
      }

      case 'combine': {
        const { paths, destination, separator = '\n\n---\n\n', includeFilenames = false, overwrite = false, sortBy, sortOrder = 'asc' } = params;

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
          totalSize: finalContent.length
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
      copiedTo: destination
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
      skippedFiles
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
    // Skip limiting for vault read operations and view file operations - we want the full document/image
    const shouldLimit = !(operation === 'vault' && action === 'read') &&
      !(operation === 'view' && action === 'file');

    // Limit the result size to prevent token overflow (except for vault reads)
    const limitedResult = shouldLimit ? limitResponse(result) : result;

    const response: SemanticResponse = {
      result: limitedResult,
      context: this.getCurrentContext(operation)
    };

    // Add metadata if requested (default: true)
    if (params.includeMetadata !== false) {
      // Extract metadata based on operation
      const metadata = this.extractMetadata(operation, action, params, result);
      if (metadata && Object.keys(metadata).length > 0) {
        (response as any).metadata = metadata;
      }
    }

    // Workflow hints and efficiency hints removed to reduce verbosity

    return response;
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

  private getCurrentContext(operation?: string) {
    // Minimal context as requested
    const context: any = {
      current_file: this.context.last_file
    };

    // Only include search history for search operations
    if (operation === 'vault' && this.context.search_history && this.context.search_history.length > 0) {
      context.search_history = this.context.search_history;
    }

    return context;
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
      message: error.message
    };

    return errorResponse;
  }

  private extractMetadata(operation: string, action: string, params: any, result: any): any {
    const metadata: any = {};

    // Extract links and tags for read operations
    if (operation === 'vault' && action === 'read' && params.path && this.app) {
      const file = this.app.vault.getAbstractFileByPath(params.path);
      if (file instanceof TFile) {
        // Get tags from cache
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.tags) {
          metadata.tags = cache.tags.map(t => t.tag);
        }

        // Get outgoing links
        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        if (resolvedLinks[params.path]) {
          metadata.links = metadata.links || {};
          metadata.links.outgoing = Object.keys(resolvedLinks[params.path]);
        }

        // Get incoming links (backlinks)
        const incoming: string[] = [];
        for (const sourcePath in resolvedLinks) {
          if (resolvedLinks[sourcePath][params.path]) {
            incoming.push(sourcePath);
          }
        }

        if (incoming.length > 0) {
          metadata.links = metadata.links || {};
          metadata.links.incoming = incoming;
        }
      }
    }

    return metadata;
  }
}