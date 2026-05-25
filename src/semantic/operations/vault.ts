/**
 * Vault operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeVaultOperation and its
 * vault-private helpers. The router passes itself as the RouterContext, so
 * `ctx.api`/`ctx.app`/etc. are the same instances as before.
 */
import { Debug } from '../../utils/debug';
import { isImageFile, ObsidianFileResponse } from '../../types/obsidian';
import { readFileWithFragments } from '../../utils/file-reader';
import { ValidationException } from '../../validation/input-validator';
import { RouterContext } from './router-context';
import { Params, paramStr, paramNum, paramBool, requireParamStr } from './shared';

export async function executeVaultOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
    switch (action) {
      case 'list': {
        // Translate "/" to undefined for root directory
        const dirParam = paramStr(params, 'directory');
        const directory = dirParam === '/' ? undefined : dirParam;

        // Use paginated list if page parameters are provided.
        // When paginating inside a specific directory, recurse so the
        // agent sees the same universe of files as the non-paginated
        // call — page N gives the Nth slice of the recursive listing,
        // not a level-only folder enumeration. The root case is
        // already recursive (getAllLoadedFiles), so we leave
        // recursive=false there; listFilesPaginated routes through
        // the same path regardless.
        if (params.page || params.pageSize) {
          // MCP clients send these as JSON numbers; paramStr returns undefined
          // for non-strings, so parseInt(paramStr(...) ?? '1') silently
          // collapsed to defaults and made pagination a no-op.
          const page = paramNum(params, 'page') ?? 1;
          const pageSize = paramNum(params, 'pageSize') ?? 20;
          const recursive = directory !== undefined;
          return await ctx.api.listFilesPaginated(directory, page, pageSize, recursive);
        }

        // Fallback to simple list for backwards compatibility
        return await ctx.api.listFiles(directory);
      }
      case 'read': {
        const path = paramStr(params, 'path') ?? '';
        const strategy = paramStr(params, 'strategy') as 'auto' | 'adaptive' | 'proximity' | 'semantic' | undefined;
        return await readFileWithFragments(ctx.api, ctx.fragmentRetriever, {
          path,
          returnFullFile: paramBool(params, 'returnFullFile'),
          page: paramNum(params, 'page'),
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
          const searchResults = await ctx.api.searchPaginated(fragmentQuery, 1, 20, 'combined', false);

          // Index only the files that match the search
          if (searchResults && searchResults.results && searchResults.results.length > 0) {
            for (const result of searchResults.results.slice(0, 20)) { // Limit to first 20 files
              try {
                const filePath = result.path;
                if (filePath && filePath.endsWith('.md')) {
                  const fileResponse = await ctx.api.getFile(filePath);
                  let content: string;

                  if (typeof fileResponse === 'string') {
                    content = fileResponse;
                  } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
                    content = fileResponse.content;
                  } else {
                    continue;
                  }

                  const docId = `file:${filePath}`;
                  ctx.fragmentRetriever.indexDocument(docId, filePath, content);
                }
              } catch (e) {
                // Skip files that can't be indexed
                Debug.log(`Skipping file during fragment indexing:`, e);
              }
            }
          }

          // Search for fragments in indexed documents
          const fragmentResponse = ctx.fragmentRetriever.retrieveFragments(fragmentQuery, {
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
      case 'create': {
        const path = requireParamStr(params, 'path', 'vault.create');
        // Empty content is a legitimate "touch" — only the path is required.
        const content = paramStr(params, 'content') ?? '';
        return await ctx.api.createFile(path, content);
      }
      case 'update': {
        const path = requireParamStr(params, 'path', 'vault.update');
        const content = requireParamStr(
          params,
          'content',
          'vault.update',
          "For partial replacement, use edit.patch with operation='replace', oldText, newText — or edit.window for fuzzy in-place edits.",
        );
        return await ctx.api.updateFile(path, content);
      }
      case 'delete': {
        const path = requireParamStr(params, 'path', 'vault.delete');
        return await ctx.api.deleteFile(path);
      }
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
          // MCP clients send these as JSON numbers — use paramNum, not paramStr.
          const page = paramNum(params, 'page') ?? 1;
          const pageSize = paramNum(params, 'pageSize') ?? 10;
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
            searchOptions.snippetLength = paramNum(params, 'snippetLength') ?? 0;
          }

          const searchResults = await ctx.api.searchPaginated(
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
            const fallbackResults = await ctx.api.searchPaginated(
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
        const sourceFile = await ctx.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`Source file not found: ${path}`);
        }

        // Check if destination already exists
        try {
          const destFile = await ctx.api.getFile(destination);
          if (destFile && !overwrite) {
            throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
          }
        } catch {
          // File doesn't exist, which is what we want
        }

        // Directory creation is handled automatically by createFile

        // Use Obsidian's rename method (which handles moves)
        if (ctx.app) {
          const file = ctx.app.vault.getAbstractFileByPath(path);
          if (file && 'extension' in file) {
            await ctx.app.fileManager.renameFile(file, destination);
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
        const sourceFileData = await ctx.api.getFile(path);
        if (isImageFile(sourceFileData)) {
          throw new Error('Cannot move image files using fallback method');
        }
        const content = sourceFileData.content;
        await ctx.api.createFile(destination, content);
        await ctx.api.deleteFile(path);
        
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
        const sourceFile = await ctx.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`File not found: ${path}`);
        }

        // Extract directory from current path
        const lastSlash = path.lastIndexOf('/');
        const dir = lastSlash >= 0 ? path.substring(0, lastSlash) : '';
        const newPath = dir ? `${dir}/${newName}` : newName;

        // Check if destination already exists
        try {
          const destFile = await ctx.api.getFile(newPath);
          if (destFile && !overwrite) {
            throw new Error(`File already exists: ${newPath}. Set overwrite=true to replace.`);
          }
        } catch {
          // File doesn't exist, which is what we want
        }

        // Use Obsidian's rename method
        if (ctx.app) {
          const file = ctx.app.vault.getAbstractFileByPath(path);
          if (file && 'extension' in file) {
            await ctx.app.fileManager.renameFile(file, newPath);
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
        const sourceFileData = await ctx.api.getFile(path);
        if (isImageFile(sourceFileData)) {
          throw new Error('Cannot rename image files using fallback method');
        }
        const content = sourceFileData.content;
        await ctx.api.createFile(newPath, content);
        await ctx.api.deleteFile(path);
        
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
          const sourceFile = await ctx.api.getFile(path);
          return await copyFile(ctx, path, destination, overwrite, sourceFile);
        } catch {
          // If file operation failed, try as directory (this will also go through security validation)
          try {
            // Test if it's a directory by trying to list its contents
            await ctx.api.listFiles(path);
            // If listing succeeds, it's a directory
            return await copyDirectoryRecursive(ctx, path, destination, overwrite);
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
        const sourceFile = await ctx.api.getFile(path);
        if (!sourceFile) {
          throw new Error(`File not found: ${path}`);
        }

        if (isImageFile(sourceFile)) {
          throw new Error('Cannot split image files');
        }

        // Split the content
        const splitFiles = splitContent(sourceFile.content, params);
        
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
          await ctx.api.createFile(outputPath, splitFiles[i].content);
          
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
        const validationResult = ctx.validator.validate('batch.combine', { paths, path: destination });
        if (!validationResult.valid) {
          throw new ValidationException(
            validationResult.errors || [],
            `Validation failed for combine: ${validationResult.errors?.map(e => e.message).join(', ')}`
          );
        }

        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          throw new Error('paths array is required for combine operation');
        }

        // When a destination is given, refuse to clobber it unless overwrite.
        // When omitted, the combined content is returned inline (no write) —
        // see the inline branch below.
        if (destination) {
          try {
            const destFile = await ctx.api.getFile(destination);
            if (destFile && !overwrite) {
              throw new Error(`Destination already exists: ${destination}. Set overwrite=true to replace.`);
            }
          } catch {
            // File doesn't exist, which is what we want
          }
        }

        // Validate and get all source files
        const sourceFiles = [];
        for (const path of paths) {
          const file = await ctx.api.getFile(path);
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
          sortFiles(sourceFiles, sortBy, sortOrder);
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

        // No destination → return the combined content inline without writing
        // to the vault. Lets read-only consumers use combine for multi-file
        // retrieval with no side effects.
        if (!destination) {
          return {
            success: true,
            inline: true,
            content: finalContent,
            filesCombined: paths.length,
            totalSize: finalContent.length,
            // Reflect the order the content was actually combined in
            // (sortFiles mutates sourceFiles in place when sortBy is set),
            // so consumers can map sections back to files correctly.
            sourceFiles: sourceFiles.map(f => f.path),
            workflow: {
              message: `Combined ${paths.length} files inline (no file written)`,
              suggested_next: [
                {
                  description: 'Save the combined content to a file',
                  command: `vault(action='combine', paths=${JSON.stringify(paths)}, destination='combined.md')`
                }
              ]
            }
          };
        }

        // Create or update destination file
        if (overwrite) {
          await ctx.api.updateFile(destination, finalContent);
        } else {
          await ctx.api.createFile(destination, finalContent);
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
        return executeVaultOperation(ctx, 'combine', {
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
  
function splitContent(content: string, params: Params): Array<{ content: string }> {
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
  
function sortFiles(files: Array<{ path: string; content: string }>, sortBy: string, sortOrder: string): void {
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
async function copyFile(ctx: RouterContext, path: string, destination: string, overwrite: boolean, sourceFile: ObsidianFileResponse): Promise<unknown> {
    // Check if destination already exists
    try {
      const destFile = await ctx.api.getFile(destination);
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
      await ctx.api.updateFile(destination, content);
    } else {
      await ctx.api.createFile(destination, content);
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
   * Recursively copy a directory and all its contents
   */
async function copyDirectoryRecursive(ctx: RouterContext, sourcePath: string, destPath: string, overwrite: boolean): Promise<unknown> {
    const copiedFiles: string[] = [];
    const skippedFiles: string[] = [];
    
    const copyDir = async (srcDir: string, destDir: string) => {
      // Use listFilesPaginated to get both files and directories
      const response = await ctx.api.listFilesPaginated(srcDir, 1, 1000); // Get large page to avoid pagination
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
            const sourceFile = await ctx.api.getFile(srcPath);
            if (isImageFile(sourceFile)) {
              Debug.warn(`Skipping image file: ${srcPath}`);
              skippedFiles.push(srcPath);
              continue;
            }
            
            // Check destination exists if not overwriting
            if (!overwrite) {
              try {
                await ctx.api.getFile(destFilePath);
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
              await ctx.api.updateFile(destFilePath, content);
            } else {
              await ctx.api.createFile(destFilePath, content);
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
