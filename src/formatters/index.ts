/**
 * Presentation Facade - Formatters Index
 *
 * Exports all formatters for converting raw API responses
 * to AI-readable markdown output.
 */

// Import all formatters for internal use
import {
  formatSearchResults,
  formatFragmentResults,
  SearchResponse,
  SearchResult,
  FragmentResult
} from './search';

import {
  formatFileList,
  formatFileRead,
  formatFileWrite,
  formatFileDelete,
  formatFileMove,
  formatFileSplit,
  formatFileCombine,
  FileListItem,
  FileListResponse,
  FileReadResponse,
  FileWriteResponse,
  FileDeleteResponse,
  FileMoveResponse,
  FileSplitResponse,
  FileCombineResponse
} from './vault';

import {
  formatViewFile,
  formatViewWindow,
  formatViewActive,
  formatOpenInObsidian,
  ViewFileResponse,
  ViewWindowResponse,
  ViewActiveResponse,
  OpenInObsidianResponse
} from './view';

import {
  formatGraphTraverse,
  formatGraphNeighbors,
  formatGraphPath,
  formatGraphStats,
  formatTagAnalysis,
  formatSharedTags,
  formatSearchTraverse,
  GraphNode,
  GraphTraverseResponse,
  GraphNeighborsNode,
  GraphNeighborsEdge,
  GraphNeighborsResponse,
  GraphPathNode,
  GraphPathResponse,
  GraphStatsResponse,
  TagAnalysisResponse,
  SharedTagsResponse,
  SearchTraverseResponse
} from './graph';

import {
  formatDataviewQuery,
  formatDataviewStatus,
  formatBasesQuery,
  formatBasesList,
  formatBasesRead,
  formatBasesCreate,
  formatBasesExport,
  DataviewQueryResponse,
  DataviewStatusResponse,
  BasesQueryResponse,
  BasesListResponse,
  BasesReadResponse,
  BasesCreateResponse,
  BasesExportResponse
} from './dataview';

import {
  formatSystemInfo,
  formatSystemCommands,
  formatWorkflowSuggest,
  formatEditResult,
  formatWebFetch,
  SystemInfoResponse,
  CommandInfo,
  SystemCommandsResponse,
  WorkflowSuggestion,
  WorkflowSuggestResponse,
  EditResponse,
  WebFetchResponse
} from './system';

// Re-export utility functions
export {
  truncate,
  interpretScore,
  formatFileSize,
  formatDate,
  header,
  property,
  divider,
  tip,
  summaryFooter,
  joinLines,
  formatPath,
  formatTree
} from './utils';

// Re-export all formatters and types
export {
  // Search
  formatSearchResults,
  formatFragmentResults,
  SearchResponse,
  SearchResult,
  FragmentResult,
  // Vault
  formatFileList,
  formatFileRead,
  formatFileWrite,
  formatFileDelete,
  formatFileMove,
  formatFileSplit,
  formatFileCombine,
  FileListItem,
  FileListResponse,
  FileReadResponse,
  FileWriteResponse,
  FileDeleteResponse,
  FileMoveResponse,
  FileSplitResponse,
  FileCombineResponse,
  // View
  formatViewFile,
  formatViewWindow,
  formatViewActive,
  formatOpenInObsidian,
  ViewFileResponse,
  ViewWindowResponse,
  ViewActiveResponse,
  OpenInObsidianResponse,
  // Graph
  formatGraphTraverse,
  formatGraphNeighbors,
  formatGraphPath,
  formatGraphStats,
  formatTagAnalysis,
  formatSharedTags,
  formatSearchTraverse,
  GraphNode,
  GraphTraverseResponse,
  GraphNeighborsNode,
  GraphNeighborsEdge,
  GraphNeighborsResponse,
  GraphPathNode,
  GraphPathResponse,
  GraphStatsResponse,
  TagAnalysisResponse,
  SharedTagsResponse,
  SearchTraverseResponse,
  // Dataview
  formatDataviewQuery,
  formatDataviewStatus,
  formatBasesQuery,
  formatBasesList,
  formatBasesRead,
  formatBasesCreate,
  formatBasesExport,
  DataviewQueryResponse,
  DataviewStatusResponse,
  BasesQueryResponse,
  BasesListResponse,
  BasesReadResponse,
  BasesCreateResponse,
  BasesExportResponse,
  // System
  formatSystemInfo,
  formatSystemCommands,
  formatWorkflowSuggest,
  formatEditResult,
  formatWebFetch,
  SystemInfoResponse,
  CommandInfo,
  SystemCommandsResponse,
  WorkflowSuggestion,
  WorkflowSuggestResponse,
  EditResponse,
  WebFetchResponse
};

/** Shape for a raw fragment from the router */
interface RawFragment {
  docPath?: string;
  path?: string;
  content?: string;
  lineStart?: number;
  lineEnd?: number;
  score?: number;
  heading?: string;
}

/** Shape for router move/rename responses */
interface MoveRenameResponse {
  oldPath?: string;
  newPath?: string;
  sourcePath?: string;
  destination?: string;
  success?: boolean;
}

/** Shape for router copy responses */
interface CopyResponse {
  sourcePath?: string;
  copiedTo?: string;
  source?: string;
  destination?: string;
  success?: boolean;
}

/** Shape for router fragment responses */
interface FragmentsResponse {
  result?: RawFragment[];
  query?: string;
}

/** Shape for router edit responses */
interface EditResponse2 {
  isError?: boolean;
  path?: string;
  content?: string;
  success?: boolean;
  line?: number;
  mode?: string;
}

/**
 * Generic normalized response - all possible fields from various operations.
 * Individual formatters will pick the fields they need.
 */
type NormalizedResponse = Record<string, unknown>;

/**
 * Normalize response shapes to match formatter expectations.
 * Maps field names from router responses to what formatters expect.
 */
function normalizeResponse(key: string, response: unknown): NormalizedResponse {
  // Ensure response is an object we can inspect
  const resp = (typeof response === 'object' && response !== null ? response : {}) as Record<string, unknown>;

  switch (key) {
    // vault.move/rename: router returns {oldPath, newPath}, formatter expects {source, destination}
    case 'vault.move':
    case 'vault.rename': {
      const moveResp = resp as MoveRenameResponse;
      if (moveResp.oldPath !== undefined || moveResp.newPath !== undefined) {
        return {
          source: moveResp.oldPath ?? moveResp.sourcePath,
          destination: moveResp.newPath ?? moveResp.destination,
          success: moveResp.success ?? true,
          operation: key === 'vault.move' ? 'move' : 'rename'
        };
      }
      return resp;
    }

    // vault.copy: router returns {sourcePath, copiedTo}, formatter expects {source, destination}
    case 'vault.copy': {
      const copyResp = resp as CopyResponse;
      if (copyResp.sourcePath !== undefined || copyResp.copiedTo !== undefined) {
        return {
          source: copyResp.sourcePath ?? copyResp.source,
          destination: copyResp.copiedTo ?? copyResp.destination,
          success: copyResp.success ?? true,
          operation: 'copy'
        };
      }
      return resp;
    }

    // vault.fragments: router returns {result: [...fragments across files]}
    // Transform to grouped format for formatter
    case 'vault.fragments': {
      const fragResp = resp as FragmentsResponse;
      if (fragResp.result && Array.isArray(fragResp.result)) {
        // Group fragments by file path
        const byFile = new Map<string, RawFragment[]>();
        for (const frag of fragResp.result) {
          const path = frag.docPath ?? frag.path ?? 'unknown';
          if (!byFile.has(path)) {
            byFile.set(path, []);
          }
          byFile.get(path)!.push({
            content: frag.content,
            lineStart: frag.lineStart,
            lineEnd: frag.lineEnd,
            score: frag.score,
            heading: frag.heading
          });
        }
        // Return as array of file results
        return {
          files: Array.from(byFile.entries()).map(([path, fragments]) => ({
            path,
            fragments,
            totalFragments: fragments.length
          })),
          totalResults: fragResp.result.length,
          query: fragResp.query
        };
      }
      return resp;
    }

    // edit.window: router returns {isError, content}, formatter expects {success, path}
    case 'edit.window':
    case 'edit.from_buffer': {
      const editResp = resp as EditResponse2;
      if (editResp.isError !== undefined) {
        return {
          success: !editResp.isError,
          path: editResp.path ?? 'file',
          operation: 'window',
          content: editResp.content
        };
      }
      return resp;
    }

    // edit.at_line: ensure consistent shape
    case 'edit.at_line': {
      const lineResp = resp as EditResponse2;
      return {
        success: lineResp.success ?? true,
        path: lineResp.path ?? 'file',
        operation: 'at_line',
        line: lineResp.line,
        mode: lineResp.mode
      };
    }

    // system.commands: router returns a flat array, formatter expects {commands: [...]}
    case 'system.commands': {
      if (Array.isArray(response)) {
        return { commands: response };
      }
      return resp;
    }

    // graph.traverse: router returns {nodes: [{path,title,type,links}], edges, graphStats, message}
    // formatter expects {sourcePath, maxDepth, nodes: [{path,title,depth}], totalNodes}
    case 'graph.traverse': {
      const traverseNodes = resp.nodes as Array<Record<string, unknown>> | undefined;
      const graphStats = resp.graphStats as Record<string, unknown> | undefined;
      const edges = (resp.edges as Array<Record<string, unknown>>) || [];
      if (traverseNodes && Array.isArray(traverseNodes)) {
        return {
          sourcePath: resp.sourcePath ?? resp.message ?? '',
          maxDepth: graphStats?.maxDepthReached ?? 3,
          totalNodes: graphStats?.totalNodes ?? traverseNodes.length,
          nodes: traverseNodes.map(n => {
            const outgoing = edges
              .filter(e => e.source === n.path)
              .map(e => (e.target as string).split('/').pop() || e.target);
            return {
              path: n.path,
              title: n.title,
              depth: 0, // depth per node not tracked in this response shape
              links: outgoing.length > 0 ? outgoing : undefined,
              tags: n.tags
            };
          }),
          edges: resp.edges,
          graphStats
        };
      }
      return resp;
    }

    // graph.advanced-traverse: same shape as search-traverse but snippetChain is
    // embedded inside details.traversalChain instead of top-level snippetChain
    case 'graph.advanced-traverse':
    case 'graph.tag-traverse': {
      // If snippetChain already exists, pass through (tag-traverse has it)
      if (resp.snippetChain) return resp;

      // For advanced-traverse, build snippetChain from details.traversalChain
      const details = resp.details as Record<string, unknown> | undefined;
      const chain = details?.traversalChain as Array<Record<string, unknown>> | undefined;
      if (details && chain) {
        return {
          summary: resp.summary,
          traversalPath: resp.traversalPath,
          details: {
            startNode: details.startNode,
            searchQuery: details.searchQuery ?? (details.searchQueries as string[] | undefined)?.join(', ') ?? '',
            maxDepth: details.maxDepth,
            totalNodesVisited: details.totalNodesVisited,
            nodesWithMatches: chain.length,
            executionTime: details.executionTime
          },
          snippetChain: chain.map(node => ({
            file: node.path,
            depth: node.depth ?? 0,
            parent: node.parentPath,
            snippet: node.snippet ?? { text: '', score: '0', lineNumber: 0, preview: '' }
          })),
          workflowSuggestions: resp.workflowSuggestions ?? []
        };
      }
      return resp;
    }

    // graph.tag-analysis: router returns {file, tags, tagConnections: {tag: [paths]}, summary, strongestConnections}
    // formatter expects {totalTags, totalFiles, tags: [{tag, count, files}]}
    case 'graph.tag-analysis': {
      const tagConns = resp.tagConnections as Record<string, string[]> | undefined;
      const fileTags = resp.tags as string[] | undefined;
      if (fileTags && tagConns) {
        const allFiles = new Set<string>();
        const formattedTags = fileTags.map(tag => {
          const files = tagConns[tag] || [];
          files.forEach(f => allFiles.add(f));
          return { tag, count: files.length, files };
        });
        return {
          sourcePath: resp.file,
          totalTags: fileTags.length,
          totalFiles: allFiles.size,
          tags: formattedTags,
          summary: resp.summary
        };
      }
      return resp;
    }

    // graph.shared-tags: router returns {source, target, sharedTags, connectionStrength, summary}
    // formatter expects {sourcePath, results: [{file1, file2, sharedTags, similarity}], totalMatches}
    case 'graph.shared-tags': {
      const sharedTags = resp.sharedTags as string[] | undefined;
      if (resp.source !== undefined && resp.target !== undefined) {
        return {
          sourcePath: resp.source,
          totalMatches: sharedTags?.length ?? 0,
          results: sharedTags && sharedTags.length > 0 ? [{
            file1: resp.source as string,
            file2: resp.target as string,
            sharedTags,
            similarity: sharedTags.length > 0 ? 1.0 : 0
          }] : [],
          summary: resp.summary
        };
      }
      return resp;
    }

    default:
      return resp;
  }
}

/**
 * Format dispatcher - routes responses to appropriate formatters
 * based on the tool/action combination.
 *
 * @param tool - The MCP tool name (vault, view, graph, etc.)
 * @param action - The action performed (list, read, search, etc.)
 * @param response - The raw response data
 * @param raw - If true, return raw JSON instead of formatted markdown
 * @returns Formatted markdown string or raw JSON string
 */
export function formatResponse(
  tool: string,
  action: string,
  response: unknown,
  raw: boolean = false
): string {
  // If raw requested, return JSON
  if (raw) {
    return JSON.stringify(response, null, 2);
  }

  // Route to appropriate formatter
  const key = `${tool}.${action}`;

  // Normalize response shape before formatting
  // Cast to unknown since normalizeResponse returns Record<string, unknown>
  // which needs to be narrowed to specific formatter types
  const normalized: unknown = normalizeResponse(key, response);

  try {
    switch (key) {
      // Vault operations
      case 'vault.list':
        return formatFileList(normalized as FileListResponse);
      case 'vault.read':
        return formatFileRead(normalized as FileReadResponse);
      case 'vault.create':
        return formatFileWrite(normalized as FileWriteResponse, 'create');
      case 'vault.update':
        return formatFileWrite(normalized as FileWriteResponse, 'update');
      case 'vault.delete':
        return formatFileDelete(normalized as FileDeleteResponse);
      case 'vault.move':
      case 'vault.rename':
      case 'vault.copy':
        return formatFileMove(normalized as FileMoveResponse);
      case 'vault.search':
        return formatSearchResults(normalized as SearchResponse);
      case 'vault.fragments':
        return formatFragmentResults(normalized as FragmentResult);
      case 'vault.split':
        return formatFileSplit(normalized as FileSplitResponse);
      case 'vault.combine':
      case 'vault.concatenate':
        return formatFileCombine(normalized as FileCombineResponse);

      // View operations
      case 'view.file':
        return formatViewFile(normalized as ViewFileResponse);
      case 'view.window':
        return formatViewWindow(normalized as ViewWindowResponse);
      case 'view.active':
        return formatViewActive(normalized as ViewActiveResponse);
      case 'view.open_in_obsidian':
        return formatOpenInObsidian(normalized as OpenInObsidianResponse);

      // Graph operations
      case 'graph.traverse':
        return formatGraphTraverse(normalized as GraphTraverseResponse);
      case 'graph.neighbors':
        return formatGraphNeighbors(normalized as GraphNeighborsResponse);
      case 'graph.path':
        return formatGraphPath(normalized as GraphPathResponse);
      case 'graph.statistics':
        return formatGraphStats(normalized as GraphStatsResponse);
      case 'graph.backlinks':
      case 'graph.forwardlinks':
        return formatGraphNeighbors(normalized as GraphNeighborsResponse);
      case 'graph.search-traverse':
      case 'graph.advanced-traverse':
      case 'graph.tag-traverse':
        return formatSearchTraverse(normalized as SearchTraverseResponse);
      case 'graph.tag-analysis':
        return formatTagAnalysis(normalized as TagAnalysisResponse);
      case 'graph.shared-tags':
        return formatSharedTags(normalized as SharedTagsResponse);

      // Dataview operations
      case 'dataview.query':
        return formatDataviewQuery(normalized as DataviewQueryResponse);
      case 'dataview.status':
        return formatDataviewStatus(normalized as DataviewStatusResponse);
      case 'dataview.list':
      case 'dataview.metadata':
        return formatDataviewQuery({ ...(normalized as Record<string, unknown>), type: 'list', successful: true } as DataviewQueryResponse);

      // Bases operations
      case 'bases.list':
        return formatBasesList(normalized as BasesListResponse);
      case 'bases.read':
        return formatBasesRead(normalized as BasesReadResponse);
      case 'bases.create':
        return formatBasesCreate(normalized as BasesCreateResponse);
      case 'bases.query':
      case 'bases.view':
        return formatBasesQuery(normalized as BasesQueryResponse);
      case 'bases.export':
        return formatBasesExport(normalized as BasesExportResponse);

      // System operations
      case 'system.info':
        return formatSystemInfo(normalized as SystemInfoResponse);
      case 'system.commands':
        return formatSystemCommands(normalized as SystemCommandsResponse);
      case 'system.fetch_web':
        return formatWebFetch(normalized as WebFetchResponse);

      // Workflow operations
      case 'workflow.suggest':
        return formatWorkflowSuggest(normalized as WorkflowSuggestResponse);

      // Edit operations
      case 'edit.window':
      case 'edit.from_buffer':
      case 'edit.append':
      case 'edit.patch':
      case 'edit.at_line':
        return formatEditResult(normalized as EditResponse);

      // Default: return formatted JSON with hint
      default:
        return formatUnknownResponse(tool, action, response);
    }
  } catch (error) {
    // On formatter error, fall back to JSON with error note
    console.error(`Formatter error for ${key}:`, error);
    return `_Formatter error, showing raw data:_\n\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``;
  }
}

/**
 * Format unknown or unmapped responses
 */
function formatUnknownResponse(tool: string, action: string, response: unknown): string {
  const lines: string[] = [];

  lines.push(`# ${tool}.${action}`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(response, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('_No specific formatter for this operation. Showing raw response._');

  return lines.join('\n');
}
