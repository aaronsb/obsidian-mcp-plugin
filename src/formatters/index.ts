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
  FileListItem,
  FileListResponse,
  FileReadResponse,
  FileWriteResponse,
  FileDeleteResponse,
  FileMoveResponse
} from './vault';

import {
  formatViewFile,
  formatViewWindow,
  formatViewActive,
  ViewFileResponse,
  ViewWindowResponse,
  ViewActiveResponse
} from './view';

import {
  formatGraphTraverse,
  formatGraphNeighbors,
  formatGraphPath,
  formatGraphStats,
  GraphNode,
  GraphTraverseResponse,
  GraphNeighborsNode,
  GraphNeighborsEdge,
  GraphNeighborsResponse,
  GraphPathNode,
  GraphPathResponse,
  GraphStatsResponse
} from './graph';

import {
  formatDataviewQuery,
  formatDataviewStatus,
  formatBasesQuery,
  DataviewQueryResponse,
  DataviewStatusResponse,
  BasesQueryResponse
} from './dataview';

import {
  formatSystemInfo,
  formatSystemCommands,
  formatWorkflowSuggest,
  formatEditResult,
  SystemInfoResponse,
  CommandInfo,
  SystemCommandsResponse,
  WorkflowSuggestion,
  WorkflowSuggestResponse,
  EditResponse
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
  FileListItem,
  FileListResponse,
  FileReadResponse,
  FileWriteResponse,
  FileDeleteResponse,
  FileMoveResponse,
  // View
  formatViewFile,
  formatViewWindow,
  formatViewActive,
  ViewFileResponse,
  ViewWindowResponse,
  ViewActiveResponse,
  // Graph
  formatGraphTraverse,
  formatGraphNeighbors,
  formatGraphPath,
  formatGraphStats,
  GraphNode,
  GraphTraverseResponse,
  GraphNeighborsNode,
  GraphNeighborsEdge,
  GraphNeighborsResponse,
  GraphPathNode,
  GraphPathResponse,
  GraphStatsResponse,
  // Dataview
  formatDataviewQuery,
  formatDataviewStatus,
  formatBasesQuery,
  DataviewQueryResponse,
  DataviewStatusResponse,
  BasesQueryResponse,
  // System
  formatSystemInfo,
  formatSystemCommands,
  formatWorkflowSuggest,
  formatEditResult,
  SystemInfoResponse,
  CommandInfo,
  SystemCommandsResponse,
  WorkflowSuggestion,
  WorkflowSuggestResponse,
  EditResponse
};

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

  try {
    switch (key) {
      // Vault operations
      case 'vault.list':
        return formatFileList(response);
      case 'vault.read':
        return formatFileRead(response);
      case 'vault.create':
        return formatFileWrite(response, 'create');
      case 'vault.update':
        return formatFileWrite(response, 'update');
      case 'vault.delete':
        return formatFileDelete(response);
      case 'vault.move':
      case 'vault.rename':
      case 'vault.copy':
        return formatFileMove(response);
      case 'vault.search':
        return formatSearchResults(response);
      case 'vault.fragments':
        return formatFragmentResults(response);

      // View operations
      case 'view.file':
        return formatViewFile(response);
      case 'view.window':
        return formatViewWindow(response);
      case 'view.active':
        return formatViewActive(response);

      // Graph operations
      case 'graph.traverse':
      case 'graph.advanced-traverse':
      case 'graph.tag-traverse':
        return formatGraphTraverse(response);
      case 'graph.neighbors':
        return formatGraphNeighbors(response);
      case 'graph.path':
        return formatGraphPath(response);
      case 'graph.statistics':
      case 'graph.backlinks':
      case 'graph.forwardlinks':
        return formatGraphStats(response);

      // Dataview operations
      case 'dataview.query':
        return formatDataviewQuery(response);
      case 'dataview.status':
        return formatDataviewStatus(response);
      case 'dataview.list':
      case 'dataview.metadata':
        return formatDataviewQuery({ ...response, type: 'list', successful: true });

      // Bases operations
      case 'bases.query':
      case 'bases.view':
        return formatBasesQuery(response);

      // System operations
      case 'system.info':
        return formatSystemInfo(response);
      case 'system.commands':
        return formatSystemCommands(response);

      // Workflow operations
      case 'workflow.suggest':
        return formatWorkflowSuggest(response);

      // Edit operations
      case 'edit.window':
      case 'edit.append':
      case 'edit.patch':
      case 'edit.at_line':
        return formatEditResult(response);

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
