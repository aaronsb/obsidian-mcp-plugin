import { Debug } from '../utils/debug';
import { ObsidianAPI } from '../utils/obsidian-api';
import { SemanticRouter } from '../semantic/router';
import { SemanticRequest } from '../types/semantic';
import { isImageFile } from '../utils/image-handler';
import { isImageFile as isImageFileObject } from '../types/obsidian';
import { App } from 'obsidian';
import { DataviewTool, isDataviewToolAvailable } from './dataview-tool';
import { formatResponse } from '../formatters';

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
      raw: {
        type: 'boolean',
        description: 'Return raw JSON instead of formatted markdown (use when you need complete metadata or structured data for processing)',
        default: false
      },
      ...getParametersForOperation(operation)
    },
    required: ['action']
  },
  handler: async (api: ObsidianAPI, args: any) => {
    const app = api.getApp();

    // Check for read-only mode before processing write operations
    if ((api as any).plugin?.settings?.readOnlyMode && operation === 'vault') {
      const writeOperations = ['create', 'update', 'delete', 'move', 'rename', 'copy', 'split', 'combine', 'concatenate'];
      if (writeOperations.includes(args.action)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                code: 'READ_ONLY_MODE',
                message: `Write operation '${args.action}' is blocked - read-only mode is enabled`
              },
              context: {
                readOnlyMode: true,
                operation: operation,
                action: args.action,
                blockedOperation: true
              }
            }, null, 2)
          }]
        };
      }
    }
    
    // Handle Dataview operations separately
    if (operation === 'dataview') {
      const dataviewTool = new DataviewTool(api);
      let result;

      switch (args.action) {
        case 'status':
          result = {
            result: dataviewTool.getStatus(),
            context: { operation, action: args.action }
          };
          break;
        case 'query': {
          if (!args.query) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Query parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const queryResult = await dataviewTool.executeQuery(args.query, args.format);
            result = {
              result: queryResult,
              context: { operation, action: args.action, query: args.query }
            };
          }
          break;
        }
        case 'list': {
          const listResult = await dataviewTool.listPages(args.source);
          result = {
            result: listResult,
            context: { operation, action: args.action, source: args.source }
          };
          break;
        }
        case 'metadata': {
          if (!args.path) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Path parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const metadataResult = await dataviewTool.getPageMetadata(args.path);
            result = {
              result: metadataResult,
              context: { operation, action: args.action, path: args.path }
            };
          }
          break;
        }
        case 'validate': {
          if (!args.query) {
            result = {
              error: { code: 'MISSING_PARAMETER', message: 'Query parameter is required' },
              context: { operation, action: args.action }
            };
          } else {
            const validateResult = await dataviewTool.validateQuery(args.query);
            result = {
              result: validateResult,
              context: { operation, action: args.action, query: args.query }
            };
          }
          break;
        }
        default:
          result = {
            error: { code: 'INVALID_ACTION', message: `Unknown Dataview action: ${args.action}` },
            context: { operation, action: args.action }
          };
      }

      // Format Dataview response for MCP
      if (result.error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: result.error,
              context: result.context
            }, null, 2)
          }],
          isError: true
        };
      }

      // Format Dataview success response through presentation facade
      const rawMode = args.raw === true;
      const formattedOutput = rawMode
        ? JSON.stringify({ result: result.result, context: result.context }, null, 2)
        : formatResponse('dataview', args.action, result.result, rawMode);

      return {
        content: [{
          type: 'text' as const,
          text: formattedOutput
        }]
      };
    }

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
    if (operation === 'vault' && args.action === 'read' && response.result && isImageFileObject(response.result as any)) {
      // Return image content for MCP
      const imageResult = response.result as any;
      return {
        content: [{
          type: 'image' as const,
          data: imageResult.base64Data,
          mimeType: imageResult.mimeType
        }]
      };
    }

    // Only filter image files if they contain binary data that would cause JSON errors
    // For search results, we want to show image files in the results list
    const filteredResult = response.result as any;

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
      // Format response through presentation facade
      const rawMode = args.raw === true;
      const formattedOutput = rawMode
        ? JSON.stringify({
            result: filteredResult,
            workflow: response.workflow,
            context: response.context,
            efficiency_hints: response.efficiency_hints
          }, null, 2)
        : formatResponse(operation, args.action, filteredResult, rawMode);

      return {
        content: [{
          type: 'text' as const,
          text: formattedOutput
        }]
      };
    } catch (error) {
      // Handle JSON serialization errors
      Debug.error('JSON serialization failed:', error);
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
    vault: '📁 File operations - list, read, create, update, delete, search, fragments, move, rename, copy, split, combine, concatenate. Search supports: operators (file:, path:, content:, tag:), OR/AND, "quoted phrases", /regex/. Options: ranked=true for TF-IDF relevance scoring, searchStrategy (filename|content|combined|auto), includeSnippets for contextual extracts.',
    edit: '✏️ Edit files - window: find/replace with fuzzy matching, append: add to end, patch: modify headings/blocks/frontmatter, at_line: insert at line number, from_buffer: reuse previous window content',
    view: '👁️ View content - file: entire document, window: ~20 lines around point, active: current editor file, open_in_obsidian: launch in app',
    workflow: '💡 Get contextual suggestions for next actions based on current state',
    system: 'ℹ️ System operations - info: server details, commands: available actions, fetch_web: retrieve and process web content',
    graph: '🕸️ Graph navigation - traverse: explore connections, neighbors: immediate links, path: find routes between notes, statistics: link counts, backlinks/forwardlinks: directional analysis, search-traverse: connected snippets',
    dataview: '📊 Dataview operations - query: execute DQL queries (LIST FROM "folder", TABLE field FROM #tag WHERE condition), list: get pages with metadata and frontmatter, metadata: extract complete page metadata, validate: check DQL syntax, status: plugin availability. Supports LIST, TABLE, TASK, CALENDAR queries with WHERE filters, sorting, grouping.',
    bases: '🗃️ Bases operations - list: show all .base files, read: get YAML config, create: new base with views/filters/formulas, query: execute filters on vault notes, view: get table/card view data, evaluate: test formulas, export: CSV/JSON/Markdown. Bases use YAML format with expression-based filters like status == "active" and file.hasTag("project")'
  };
  return descriptions[operation] || 'Unknown operation';
}

function getActionsForOperation(operation: string): string[] {
  const actions: Record<string, string[]> = {
    vault: ['list', 'read', 'create', 'update', 'delete', 'search', 'fragments', 'move', 'rename', 'copy', 'split', 'combine', 'concatenate'],
    edit: ['window', 'append', 'patch', 'at_line', 'from_buffer'],
    view: ['file', 'window', 'active', 'open_in_obsidian'],
    workflow: ['suggest'],
    system: ['info', 'commands', 'fetch_web'],
    graph: ['traverse', 'neighbors', 'path', 'statistics', 'backlinks', 'forwardlinks', 'search-traverse', 'advanced-traverse', 'tag-traverse', 'tag-analysis', 'shared-tags'],
    dataview: ['query', 'list', 'metadata', 'validate', 'status'],
    bases: ['list', 'read', 'create', 'query', 'view', 'export']
  };
  return actions[operation] || [];
}

function getParametersForOperation(operation: string): Record<string, unknown> {
  // Common parameters across operations
  const pathParam = {
    path: {
      type: 'string',
      description: 'File path relative to vault root'
    }
  };
  
  const contentParam = {
    content: {
      type: 'string',
      description: 'Text content to write (markdown supported)'
    }
  };
  
  // Operation-specific parameters
  const operationParams: Record<string, Record<string, unknown>> = {
    vault: {
      ...pathParam,
      directory: {
        type: 'string',
        description: 'Directory path for list operations'
      },
      query: {
        type: 'string',
        description: 'Search query - supports operators (file:, path:, content:, tag:), OR/AND, "quoted phrases", /regex/'
      },
      ranked: {
        type: 'boolean',
        description: 'Use TF-IDF relevance scoring (default: auto-detected based on query type)'
      },
      searchStrategy: {
        type: 'string',
        enum: ['auto', 'filename', 'content', 'combined'],
        description: 'Search strategy: auto (detect from query), filename (names only), content (full-text), combined (both)'
      },
      includeSnippets: {
        type: 'boolean',
        description: 'Extract contextual snippets around matches (default: true)'
      },
      snippetLength: {
        type: 'number',
        description: 'Maximum snippet length in characters (default: 300)'
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
      destination: {
        type: 'string',
        description: 'Destination path for move/copy operations'
      },
      newName: {
        type: 'string',
        description: 'New filename for rename operation (without path)'
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite if destination exists (default: false)'
      },
      // Split operation parameters
      splitBy: {
        type: 'string',
        enum: ['heading', 'delimiter', 'lines', 'size'],
        description: 'Split strategy: heading (by markdown headings), delimiter (by custom string), lines (by line count), size (by character count)'
      },
      delimiter: {
        type: 'string',
        description: 'Delimiter string/regex for delimiter strategy (default: "---")'
      },
      level: {
        type: 'number',
        description: 'Heading level for heading strategy (1-6)'
      },
      linesPerFile: {
        type: 'number',
        description: 'Number of lines per file for lines strategy (default: 100)'
      },
      maxSize: {
        type: 'number',
        description: 'Max characters per file for size strategy (default: 10000)'
      },
      outputPattern: {
        type: 'string',
        description: 'Naming pattern for output files (default: "{filename}-{index}{ext}")'
      },
      outputDirectory: {
        type: 'string',
        description: 'Directory for output files (defaults to source directory)'
      },
      // Combine operation parameters
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of file paths to combine'
      },
      separator: {
        type: 'string',
        description: 'Content separator between files (default: "\\n\\n---\\n\\n")'
      },
      includeFilenames: {
        type: 'boolean',
        description: 'Include source filenames as headers (default: false)'
      },
      sortBy: {
        type: 'string',
        enum: ['name', 'modified', 'created', 'size'],
        description: 'Sort files before combining'
      },
      sortOrder: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort order (default: "asc")'
      },
      // Concatenate operation parameters
      path1: {
        type: 'string',
        description: 'First file path for concatenation'
      },
      path2: {
        type: 'string',
        description: 'Second file path for concatenation'
      },
      mode: {
        type: 'string',
        enum: ['append', 'prepend', 'new'],
        description: 'Concatenation mode: append to path1, prepend to path1, or create new file'
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
        description: 'Structure to target: heading (use :: for nesting), block (by ID), or frontmatter (field name)'
      },
      target: {
        type: 'string',
        description: 'Target identifier (e.g., "Section::Subsection", "blockId", "status")'
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
    },
    dataview: {
      query: {
        type: 'string',
        description: 'DQL query string. Examples: "LIST FROM #project WHERE status = \\"active\\"", "TABLE file.size, rating FROM \\"Notes\\" WHERE rating > 3 SORT file.mtime DESC", "TASK FROM #todo WHERE !completed", "CALENDAR file.ctime FROM \\"Daily Notes\\""'
      },
      format: {
        type: 'string',
        enum: ['dql'],
        description: 'Query format (currently only DQL supported)',
        default: 'dql'
      },
      source: {
        type: 'string',
        description: 'Source filter for pages. Examples: "folder/path" (folder), "#tag" (tag), "[[Note Name]]" (backlinks), "" (all pages)'
      },
      ...pathParam
    },
    bases: {
      path: {
        type: 'string',
        description: 'Path to the .base file'
      },
      config: {
        type: 'object',
        description: 'Base configuration object with name, source, properties, and views'
      },
      viewName: {
        type: 'string',
        description: 'Name of the view to retrieve'
      },
      filters: {
        type: 'array',
        items: { type: 'object' },
        description: 'Array of filter objects with property, operator, and value'
      },
      sort: {
        type: 'object',
        description: 'Sort options with property and order (asc/desc)'
      },
      pagination: {
        type: 'object',
        description: 'Pagination options with page and pageSize'
      },
      includeContent: {
        type: 'boolean',
        description: 'Include note content in results'
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific properties to include in results'
      },
      basePath: {
        type: 'string',
        description: 'Path to the base for template generation'
      },
      template: {
        type: 'object',
        description: 'Template configuration with name, folder, properties, and contentTemplate'
      },
      format: {
        type: 'string',
        enum: ['csv', 'json', 'markdown'],
        description: 'Export format'
      },
      dateFormat: {
        type: 'string',
        description: 'Date format for export (e.g., YYYY-MM-DD)'
      }
    }
  };
  
  return operationParams[operation] || {};
}

/**
 * Create semantic tools array with optional Dataview support
 */
export function createSemanticTools(api?: ObsidianAPI): any[] {
  const baseTools = [
    createSemanticTool('vault'),
    createSemanticTool('edit'),
    createSemanticTool('view'),
    createSemanticTool('workflow'),
    createSemanticTool('system'),
    createSemanticTool('graph'),
    createSemanticTool('bases')
  ];

  // Add Dataview tool if available
  if (api && isDataviewToolAvailable(api)) {
    baseTools.push(createSemanticTool('dataview'));
  }

  return baseTools;
}

// Export the base 6 semantic tools (for backward compatibility)
export const semanticTools = [
  createSemanticTool('vault'),
  createSemanticTool('edit'),
  createSemanticTool('view'),
  createSemanticTool('workflow'),
  createSemanticTool('system'),
  createSemanticTool('graph'),
  createSemanticTool('bases')
];