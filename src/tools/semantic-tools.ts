import { ObsidianAPI } from '../utils/obsidian-api';
import { SemanticRouter } from '../semantic/router';
import { SemanticRequest } from '../types/semantic';
import { isImageFile } from '../utils/image-handler';
import { isImageFile as isImageFileObject } from '../types/obsidian';
import { App } from 'obsidian';

/**
 * Unified semantic tools that consolidate all operations into 5 main verbs
 */

const createSemanticTool = (operation: string) => ({
  name: operation,
  description: getOperationDescription(operation),
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The specific action to perform',
        enum: getActionsForOperation(operation)
      },
      ...getParametersForOperation(operation)
    },
    required: ['action']
  },
  handler: async (api: ObsidianAPI, args: any) => {
    const app = api.getApp();
    const router = new SemanticRouter(api, app);
    
    const request: SemanticRequest = {
      operation,
      action: args.action,
      params: args
    };
    
    const response = await router.route(request);
    
    // Format for MCP
    if (response.error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: response.error,
            workflow: response.workflow,
            context: response.context
          }, null, 2)
        }],
        isError: true
      };
    }
    
    // Check if the result is an image file for vault read operations
    if (operation === 'vault' && args.action === 'read' && response.result && isImageFileObject(response.result)) {
      // Return image content for MCP
      return {
        content: [{
          type: 'image' as const,
          data: response.result.base64Data,
          mimeType: response.result.mimeType
        }]
      };
    }
    
    // Only filter image files if they contain binary data that would cause JSON errors
    // For search results, we want to show image files in the results list
    const filteredResult = response.result;
    
    // Special handling for image files in view operations
    if (operation === 'view' && args.action === 'file' && filteredResult && filteredResult.base64Data) {
      return {
        content: [{
          type: 'image' as const,
          data: filteredResult.base64Data,
          mimeType: filteredResult.mimeType
        }]
      };
    }
    
    try {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            result: filteredResult,
            workflow: response.workflow,
            context: response.context,
            efficiency_hints: response.efficiency_hints
          }, null, 2)
        }]
      };
    } catch (error) {
      // Handle JSON serialization errors
      console.error('JSON serialization failed:', error);
      return {
        content: [{
          type: 'text' as const,
          text: `Error: Unable to serialize response. ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
});

function filterImageFilesFromSearchResults(searchResult: any): any {
  if (!searchResult) return searchResult;
  
  // Handle paginated search results format
  if (searchResult.results && Array.isArray(searchResult.results)) {
    return {
      ...searchResult,
      results: searchResult.results.filter((result: any) => {
        // Filter out results that reference image files
        if (result.filename && typeof result.filename === 'string' && isImageFile(result.filename)) {
          return false;
        }
        if (result.path && typeof result.path === 'string' && isImageFile(result.path)) {
          return false;
        }
        return true;
      })
    };
  }
  
  // Handle simple search results format (array of results)
  if (Array.isArray(searchResult)) {
    return searchResult.filter((result: any) => {
      if (result.filename && typeof result.filename === 'string' && isImageFile(result.filename)) {
        return false;
      }
      if (result.path && typeof result.path === 'string' && isImageFile(result.path)) {
        return false;
      }
      return true;
    });
  }
  
  return searchResult;
}

function getOperationDescription(operation: string): string {
  const descriptions: Record<string, string> = {
    vault: 'File and folder operations - list, read, create, update, delete, search, fragments. Search supports operators: file: (search by filename or extension, e.g. file:.png), path: (search in file path), content: (search in file content), tag: (search for tags). OR operator for multiple terms (e.g. agile OR scrum). Quoted phrases for exact matches (e.g. "user story"). Regex patterns with /pattern/flags syntax (e.g. /\\.png$/i). Operators can be combined: "user story" OR "acceptance criteria". Without operators, searches both filename and content. Results are ranked by relevance.',
    edit: 'Smart editing operations - window (auto-buffers content), append, patch, at_line, from_buffer',
    view: 'Content viewing and navigation - file, window, active, open_in_obsidian',
    workflow: 'Workflow guidance and suggestions based on current context',
    system: 'System operations - info, commands, fetch_web',
    graph: 'Graph traversal and link analysis - traverse (explore connected nodes), neighbors (get immediate connections), path (find paths between nodes), statistics (get link counts), backlinks (incoming links), forwardlinks (outgoing links), search-traverse (search-based graph traversal returning snippet chains), advanced-traverse (multi-query search traversal with strategies), tag-traverse (follow tag connections as graph edges), tag-analysis (analyze tag-based connectivity), shared-tags (find common tags between files)'
  };
  return descriptions[operation] || 'Unknown operation';
}

function getActionsForOperation(operation: string): string[] {
  const actions: Record<string, string[]> = {
    vault: ['list', 'read', 'create', 'update', 'delete', 'search', 'fragments'],
    edit: ['window', 'append', 'patch', 'at_line', 'from_buffer'],
    view: ['file', 'window', 'active', 'open_in_obsidian'],
    workflow: ['suggest'],
    system: ['info', 'commands', 'fetch_web'],
    graph: ['traverse', 'neighbors', 'path', 'statistics', 'backlinks', 'forwardlinks', 'search-traverse', 'advanced-traverse', 'tag-traverse', 'tag-analysis', 'shared-tags']
  };
  return actions[operation] || [];
}

function getParametersForOperation(operation: string): Record<string, any> {
  // Common parameters across operations
  const pathParam = {
    path: {
      type: 'string',
      description: 'Path to the file or directory'
    }
  };
  
  const contentParam = {
    content: {
      type: 'string',
      description: 'Content to write or append'
    }
  };
  
  // Operation-specific parameters
  const operationParams: Record<string, Record<string, any>> = {
    vault: {
      ...pathParam,
      directory: {
        type: 'string',
        description: 'Directory path for list operations'
      },
      query: {
        type: 'string',
        description: 'Search query'
      },
      page: {
        type: 'number',
        description: 'Page number for paginated results'
      },
      pageSize: {
        type: 'number',
        description: 'Number of results per page'
      },
      strategy: {
        type: 'string',
        enum: ['auto', 'adaptive', 'proximity', 'semantic'],
        description: 'Fragment retrieval strategy (default: auto)'
      },
      maxFragments: {
        type: 'number',
        description: 'Maximum number of fragments to return (default: 5)'
      },
      returnFullFile: {
        type: 'boolean',
        description: 'Return full file instead of fragments (WARNING: large files can consume significant context)'
      },
      includeContent: {
        type: 'boolean',
        description: 'Include file content in search results (slower but more thorough)'
      },
      ...contentParam
    },
    edit: {
      ...pathParam,
      ...contentParam,
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
      lineNumber: {
        type: 'number',
        description: 'Line number for at_line action'
      },
      mode: {
        type: 'string',
        enum: ['before', 'after', 'replace'],
        description: 'Insert mode for at_line action'
      },
      operation: {
        type: 'string',
        enum: ['append', 'prepend', 'replace'],
        description: 'Patch operation: append (add after), prepend (add before), or replace'
      },
      targetType: {
        type: 'string',
        enum: ['heading', 'block', 'frontmatter'],
        description: 'What to target: heading (by path like "H1::H2"), block (by ID), or frontmatter (field)'
      },
      target: {
        type: 'string',
        description: 'Target identifier - e.g., "Daily Notes::Today" for heading, block ID, or frontmatter field name'
      }
    },
    view: {
      ...pathParam,
      searchText: {
        type: 'string',
        description: 'Text to search for and highlight'
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
    workflow: {
      type: {
        type: 'string',
        description: 'Type of analysis or workflow'
      }
    },
    system: {
      url: {
        type: 'string',
        description: 'URL to fetch and convert to markdown'
      }
    },
    graph: {
      sourcePath: {
        type: 'string',
        description: 'Starting file path for graph operations'
      },
      targetPath: {
        type: 'string',
        description: 'Target file path (for path finding operations)'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for traversal (default: 3)'
      },
      maxNodes: {
        type: 'number',
        description: 'Maximum number of nodes to return (default: 50)'
      },
      includeUnresolved: {
        type: 'boolean',
        description: 'Include unresolved links in the results'
      },
      followBacklinks: {
        type: 'boolean',
        description: 'Follow backlinks during traversal (default: true)'
      },
      followForwardLinks: {
        type: 'boolean',
        description: 'Follow forward links during traversal (default: true)'
      },
      followTags: {
        type: 'boolean',
        description: 'Follow tag connections during traversal'
      },
      fileFilter: {
        type: 'string',
        description: 'Regex pattern to filter file names'
      },
      tagFilter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include files with these tags'
      },
      folderFilter: {
        type: 'string',
        description: 'Only include files in this folder'
      },
      // Graph search traversal parameters
      startPath: {
        type: 'string',
        description: 'Starting document path for search traversal'
      },
      searchQuery: {
        type: 'string',
        description: 'Search query to apply at each node (for search-traverse)'
      },
      searchQueries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple search queries (for advanced-traverse)'
      },
      maxSnippetsPerNode: {
        type: 'number',
        description: 'Maximum snippets to extract per node (default: 2)'
      },
      scoreThreshold: {
        type: 'number',
        description: 'Minimum score threshold for including nodes (0-1, default: 0.5)'
      },
      strategy: {
        type: 'string',
        enum: ['breadth-first', 'best-first', 'beam-search'],
        description: 'Traversal strategy (for advanced-traverse)'
      },
      beamWidth: {
        type: 'number',
        description: 'Beam width for beam-search strategy'
      },
      includeOrphans: {
        type: 'boolean',
        description: 'Include orphaned notes in traversal'
      },
      filePattern: {
        type: 'string',
        description: 'Filter traversal to files matching this pattern'
      },
      // Tag-based graph parameters
      tagWeight: {
        type: 'number',
        description: 'Weight factor for tag connections (0-1, default: 0.8)'
      }
    }
  };
  
  return operationParams[operation] || {};
}

// Export the 6 semantic tools
export const semanticTools = [
  createSemanticTool('vault'),
  createSemanticTool('edit'),
  createSemanticTool('view'),
  createSemanticTool('workflow'),
  createSemanticTool('system'),
  createSemanticTool('graph')
];