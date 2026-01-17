import { ObsidianAPI } from '../utils/obsidian-api';
import { findFuzzyMatches, extractContext } from '../utils/fuzzy-match';
import { ContentBufferManager } from '../utils/content-buffer';
import { isImageFile } from '../types/obsidian';

// Shared edit logic to avoid circular references
export async function performWindowEdit(
  api: ObsidianAPI,
  path: string,
  oldText: string,
  newText: string,
  fuzzyThreshold: number = 0.7
) {
  const buffer = ContentBufferManager.getInstance();
  
  // Get current file content
  const file = await api.getFile(path);
  if (isImageFile(file)) {
    throw new Error('Cannot perform window edits on image files');
  }
  const content = typeof file === 'string' ? file : file.content;
  
  // Try exact match first
  if (content.includes(oldText)) {
    const newContent = content.replace(oldText, newText);
    await api.updateFile(path, newContent);
    
    return {
      content: [{
        type: 'text',
        text: `Successfully replaced exact match in ${path}`
      }]
    };
  }
  
  // Buffer the new content for potential recovery
  buffer.store(newText, undefined, {
    filePath: path,
    searchText: oldText
  });
  
  // Try fuzzy matching
  const matches = findFuzzyMatches(content, oldText, fuzzyThreshold);
  
  if (matches.length === 0) {
    // No matches found, provide helpful feedback
    return {
      content: [{
        type: 'text',
        text: `No matches found for "${oldText}" in ${path}. ` +
              `Content has been buffered. You can use edit_vault_from_buffer to retry ` +
              `with different search text or insert_vault_at_line to insert at a specific line.`
      }],
      isError: true
    };
  }
  
  // If multiple matches, ask for clarification
  if (matches.length > 1) {
    const matchList = matches.map(m => 
      `Line ${m.lineNumber} (${Math.round(m.similarity * 100)}% match): "${m.line.trim()}"`
    ).join('\n');
    
    return {
      content: [{
        type: 'text',
        text: `Found ${matches.length} potential matches:\n\n${matchList}\n\n` +
              `Content has been buffered. Use insert_vault_at_line with the specific line number.`
      }],
      isError: true
    };
  }
  
  // Single match found - replace the entire line
  const match = matches[0];
  const lines = content.split('\n');
  lines[match.lineNumber - 1] = newText;
  const newContent = lines.join('\n');
  
  await api.updateFile(path, newContent);
  
  return {
    content: [{
      type: 'text',
      text: `Successfully replaced line ${match.lineNumber} (${Math.round(match.similarity * 100)}% match) in ${path}`
    }]
  };
}

export const windowEditTools = [
  {
    name: 'edit_vault_window',
    description: 'Edit a portion of a file using fuzzy string matching with automatic fallback strategies',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit'
        },
        oldText: {
          type: 'string',
          description: 'Text to search for (supports fuzzy matching)'
        },
        newText: {
          type: 'string',
          description: 'Text to replace with'
        },
        fuzzyThreshold: {
          type: 'number',
          description: 'Similarity threshold for fuzzy matching (0-1)',
          default: 0.7
        },
        contextLines: {
          type: 'number',
          description: 'Number of context lines to show on failure',
          default: 3
        }
      },
      required: ['path', 'oldText', 'newText']
    },
    handler: async (api: ObsidianAPI, args: any) => {
      try {
        return await performWindowEdit(
          api,
          args.path,
          args.oldText,
          args.newText,
          args.fuzzyThreshold || 0.7
        );
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  
  {
    name: 'edit_vault_from_buffer',
    description: 'Retry an edit using previously buffered content',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit'
        },
        oldText: {
          type: 'string',
          description: 'New text to search for (optional - uses buffer metadata if not provided)'
        },
        fuzzyThreshold: {
          type: 'number',
          description: 'Similarity threshold for fuzzy matching (0-1)',
          default: 0.7
        }
      },
      required: ['path']
    },
    handler: async (api: ObsidianAPI, args: any) => {
      const buffer = ContentBufferManager.getInstance();
      const buffered = buffer.retrieve();

      if (!buffered) {
        return {
          content: [{
            type: 'text',
            text: 'No buffered content found. Use edit_vault_window first.'
          }],
          isError: true
        };
      }

      // Use provided search text or try to extract from buffered content
      const searchText = args.oldText || buffered.searchText || buffered.content.split('\n')[0].substring(0, 50);

      // Use the shared edit function with buffered content
      try {
        return await performWindowEdit(
          api,
          args.path,
          searchText,
          buffered.content,
          args.fuzzyThreshold || 0.7
        );
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  
  {
    name: 'insert_vault_at_line',
    description: 'Insert content at a specific line number',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit'
        },
        lineNumber: {
          type: 'number',
          description: 'Line number to insert at (1-based)'
        },
        content: {
          type: 'string',
          description: 'Content to insert (optional - uses buffer if not provided)'
        },
        mode: {
          type: 'string',
          enum: ['before', 'after', 'replace'],
          description: 'Insert mode: before line, after line, or replace line',
          default: 'replace'
        }
      },
      required: ['path', 'lineNumber']
    },
    handler: async (api: ObsidianAPI, args: any) => {
      try {
        // Get content to insert
        let insertContent = args.content;
        if (!insertContent) {
          const buffer = ContentBufferManager.getInstance();
          const buffered = buffer.retrieve();
          if (!buffered) {
            return {
              content: [{
                type: 'text',
                text: 'No content provided and no buffered content found.'
              }],
              isError: true
            };
          }
          insertContent = buffered.content;
        }

        // Get current file content
        const file = await api.getFile(args.path);
        if (isImageFile(file)) {
          throw new Error('Cannot perform line-based edits on image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');

        // Validate line number
        if (args.lineNumber < 1 || args.lineNumber > lines.length + 1) {
          return {
            content: [{
              type: 'text',
              text: `Invalid line number ${args.lineNumber}. File has ${lines.length} lines.`
            }],
            isError: true
          };
        }

        // Perform the insertion
        const lineIndex = args.lineNumber - 1;
        const mode = args.mode || 'replace';

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

        const newContent = lines.join('\n');
        await api.updateFile(args.path, newContent);

        return {
          content: [{
            type: 'text',
            text: `Successfully ${mode === 'replace' ? 'replaced' : 'inserted'} content at line ${args.lineNumber} in ${args.path}`
          }]
        };

      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }
    }
  },
  
  {
    name: 'view_vault_window',
    description: 'View a portion of a file with optional search highlighting',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to view'
        },
        searchText: {
          type: 'string',
          description: 'Text to search for and center view around'
        },
        lineNumber: {
          type: 'number',
          description: 'Line number to center view around'
        },
        windowSize: {
          type: 'number',
          description: 'Number of lines to show',
          default: 20
        }
      },
      required: ['path']
    },
    handler: async (api: ObsidianAPI, args: any) => {
      try {
        const file = await api.getFile(args.path);
        if (isImageFile(file)) {
          throw new Error('Cannot view window of image files');
        }
        const content = typeof file === 'string' ? file : file.content;
        const lines = content.split('\n');

        let centerLine = args.lineNumber || 1;

        // If search text provided, find it
        if (args.searchText && !args.lineNumber) {
          const matches = findFuzzyMatches(content, args.searchText, 0.6);
          if (matches.length > 0) {
            centerLine = matches[0].lineNumber;
          }
        }

        // Calculate window
        const windowSize = args.windowSize || 20;
        const halfWindow = Math.floor(windowSize / 2);
        const startLine = Math.max(1, centerLine - halfWindow);
        const endLine = Math.min(lines.length, centerLine + halfWindow);

        // Build output with line numbers
        const windowLines = [];
        for (let i = startLine; i <= endLine; i++) {
          const line = lines[i - 1];
          const marker = i === centerLine ? '>' : ' ';
          windowLines.push(`${marker} ${i.toString().padStart(4)}: ${line}`);
        }

        let output = `File: ${args.path}\n`;
        output += `Lines ${startLine}-${endLine} of ${lines.length}\n`;
        if (args.searchText) {
          output += `Centered on: "${args.searchText}"\n`;
        }
        output += '\n' + windowLines.join('\n');

        return {
          content: [{
            type: 'text',
            text: output
          }]
        };

      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }
    }
  }
];