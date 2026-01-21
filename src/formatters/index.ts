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
  GraphNode,
  GraphTraverseResponse,
  GraphNeighborsNode,
  GraphNeighborsEdge,
  GraphNeighborsResponse,
  GraphPathNode,
  GraphPathResponse,
  GraphStatsResponse,
  TagAnalysisResponse,
  SharedTagsResponse
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

/**
 * Normalize response shapes to match formatter expectations.
 * Maps field names from router responses to what formatters expect.
 */
function normalizeResponse(key: string, response: any): any {
  switch (key) {
    // vault.move/rename: router returns {oldPath, newPath}, formatter expects {source, destination}
    case 'vault.move':
    case 'vault.rename':
      if (response.oldPath !== undefined || response.newPath !== undefined) {
        return {
          source: response.oldPath || response.sourcePath,
          destination: response.newPath || response.destination,
          success: response.success ?? true,
          operation: key === 'vault.move' ? 'move' : 'rename'
        };
      }
      return response;

    // vault.copy: router returns {sourcePath, copiedTo}, formatter expects {source, destination}
    case 'vault.copy':
      if (response.sourcePath !== undefined || response.copiedTo !== undefined) {
        return {
          source: response.sourcePath || response.source,
          destination: response.copiedTo || response.destination,
          success: response.success ?? true,
          operation: 'copy'
        };
      }
      return response;

    // vault.fragments: router returns {result: []}, formatter expects FragmentResult[]
    case 'vault.fragments':
      if (response.result && Array.isArray(response.result)) {
        return response.result;
      }
      return response;

    // edit.window: router returns {isError, content}, formatter expects {success, path}
    case 'edit.window':
    case 'edit.from_buffer':
      if (response.isError !== undefined) {
        return {
          success: !response.isError,
          path: response.path || 'file',
          operation: 'window',
          content: response.content
        };
      }
      return response;

    // edit.at_line: ensure consistent shape
    case 'edit.at_line':
      return {
        success: response.success ?? true,
        path: response.path || 'file',
        operation: 'at_line',
        line: response.line,
        mode: response.mode
      };

    default:
      return response;
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
  response: any,
  raw: boolean = false
): string {
  // If raw requested, return JSON
  if (raw) {
    return JSON.stringify(response, null, 2);
  }

  // Route to appropriate formatter
  const key = `${tool}.${action}`;

  // Normalize response shape before formatting
  const normalized = normalizeResponse(key, response);

  try {
    switch (key) {
      // Vault operations
      case 'vault.list':
        return formatFileList(normalized);
      case 'vault.read':
        return formatFileRead(normalized);
      case 'vault.create':
        return formatFileWrite(normalized, 'create');
      case 'vault.update':
        return formatFileWrite(normalized, 'update');
      case 'vault.delete':
        return formatFileDelete(normalized);
      case 'vault.move':
      case 'vault.rename':
      case 'vault.copy':
        return formatFileMove(normalized);
      case 'vault.search':
        return formatSearchResults(normalized);
      case 'vault.fragments':
        return formatFragmentResults(normalized);
      case 'vault.split':
        return formatFileSplit(normalized);
      case 'vault.combine':
      case 'vault.concatenate':
        return formatFileCombine(normalized);

      // View operations
      case 'view.file':
        return formatViewFile(normalized);
      case 'view.window':
        return formatViewWindow(normalized);
      case 'view.active':
        return formatViewActive(normalized);
      case 'view.open_in_obsidian':
        return formatOpenInObsidian(normalized);

      // Graph operations
      case 'graph.traverse':
      case 'graph.advanced-traverse':
      case 'graph.tag-traverse':
        return formatGraphTraverse(normalized);
      case 'graph.neighbors':
        return formatGraphNeighbors(normalized);
      case 'graph.path':
        return formatGraphPath(normalized);
      case 'graph.statistics':
      case 'graph.backlinks':
      case 'graph.forwardlinks':
        return formatGraphStats(normalized);
      case 'graph.tag-analysis':
        return formatTagAnalysis(normalized);
      case 'graph.shared-tags':
        return formatSharedTags(normalized);

      // Dataview operations
      case 'dataview.query':
        return formatDataviewQuery(normalized);
      case 'dataview.status':
        return formatDataviewStatus(normalized);
      case 'dataview.list':
      case 'dataview.metadata':
        return formatDataviewQuery({ ...normalized, type: 'list', successful: true });

      // Bases operations
      case 'bases.list':
        return formatBasesList(normalized);
      case 'bases.read':
        return formatBasesRead(normalized);
      case 'bases.create':
        return formatBasesCreate(normalized);
      case 'bases.query':
      case 'bases.view':
        return formatBasesQuery(normalized);
      case 'bases.export':
        return formatBasesExport(normalized);

      // System operations
      case 'system.info':
        return formatSystemInfo(normalized);
      case 'system.commands':
        return formatSystemCommands(normalized);
      case 'system.fetch_web':
        return formatWebFetch(normalized);

      // Workflow operations
      case 'workflow.suggest':
        return formatWorkflowSuggest(normalized);

      // Edit operations
      case 'edit.window':
      case 'edit.from_buffer':
      case 'edit.append':
      case 'edit.patch':
      case 'edit.at_line':
        return formatEditResult(normalized);

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
