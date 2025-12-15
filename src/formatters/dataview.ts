/**
 * Dataview and Bases operation formatters
 */

import {
  header,
  property,
  truncate,
  divider,
  tip,
  summaryFooter,
  joinLines
} from './utils';

/**
 * Format dataview.query response
 */
export interface DataviewQueryResponse {
  query: string;
  type: 'list' | 'table' | 'task' | 'calendar';
  values?: any[];
  headers?: string[];
  successful: boolean;
  error?: string;
}

export function formatDataviewQuery(response: DataviewQueryResponse): string {
  const lines: string[] = [];

  lines.push(header(1, `Dataview: ${response.type.toUpperCase()}`));
  lines.push('');
  lines.push(property('Query', truncate(response.query, 80), 0));
  lines.push('');

  if (!response.successful) {
    lines.push(`❌ Query failed: ${response.error || 'Unknown error'}`);
    lines.push('');
    lines.push(tip('Use `dataview.validate(query)` to check query syntax'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  if (!response.values || response.values.length === 0) {
    lines.push('No results found.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  // Format based on type
  if (response.type === 'table' && response.headers) {
    lines.push(formatDataviewTable(response.headers, response.values));
  } else if (response.type === 'list') {
    lines.push(formatDataviewList(response.values));
  } else if (response.type === 'task') {
    lines.push(formatDataviewTasks(response.values));
  } else {
    // Fallback for calendar or unknown
    lines.push(`${response.values.length} results returned`);
  }

  lines.push(divider());
  lines.push(tip('Use `vault.read(path)` to examine any result'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

function formatDataviewTable(headers: string[], rows: any[]): string {
  const lines: string[] = [];

  // Limit columns for readability
  const displayHeaders = headers.slice(0, 6);
  const hasMore = headers.length > 6;

  // Header row
  lines.push('| ' + displayHeaders.join(' | ') + (hasMore ? ' | ...' : '') + ' |');
  lines.push('| ' + displayHeaders.map(() => '---').join(' | ') + (hasMore ? ' | ---' : '') + ' |');

  // Data rows (limit to 20)
  rows.slice(0, 20).forEach(row => {
    const cells = displayHeaders.map((_, i) => {
      const val = Array.isArray(row) ? row[i] : row[headers[i]];
      return truncate(String(val ?? ''), 30);
    });
    lines.push('| ' + cells.join(' | ') + (hasMore ? ' | ...' : '') + ' |');
  });

  if (rows.length > 20) {
    lines.push(`\n... and ${rows.length - 20} more rows`);
  }

  return lines.join('\n');
}

function formatDataviewList(items: any[]): string {
  const lines: string[] = [];

  items.slice(0, 30).forEach((item, i) => {
    const text = typeof item === 'object' ? (item.path || item.file?.path || JSON.stringify(item)) : String(item);
    lines.push(`${i + 1}. ${truncate(text, 60)}`);
  });

  if (items.length > 30) {
    lines.push(`\n... and ${items.length - 30} more items`);
  }

  return lines.join('\n');
}

function formatDataviewTasks(tasks: any[]): string {
  const lines: string[] = [];

  tasks.slice(0, 30).forEach(task => {
    const checkbox = task.completed ? '[x]' : '[ ]';
    const text = task.text || task.task || String(task);
    lines.push(`- ${checkbox} ${truncate(text, 60)}`);
    if (task.path) {
      lines.push(`      from: ${task.path}`);
    }
  });

  if (tasks.length > 30) {
    lines.push(`\n... and ${tasks.length - 30} more tasks`);
  }

  return lines.join('\n');
}

/**
 * Format dataview.status response
 */
export interface DataviewStatusResponse {
  available: boolean;
  version?: string;
}

export function formatDataviewStatus(response: DataviewStatusResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Dataview Status'));
  lines.push('');

  if (response.available) {
    lines.push('✓ Dataview plugin is available');
    if (response.version) {
      lines.push(property('Version', response.version, 0));
    }
  } else {
    lines.push('✗ Dataview plugin is not available');
    lines.push('');
    lines.push(tip('Install the Dataview plugin from Obsidian Community Plugins'));
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format bases.query response
 */
export interface BasesQueryResponse {
  basePath: string;
  results: any[];
  totalCount: number;
}

export function formatBasesQuery(response: BasesQueryResponse): string {
  const lines: string[] = [];

  lines.push(header(1, `Base: ${response.basePath}`));
  lines.push('');
  lines.push(property('Results', response.totalCount.toString(), 0));
  lines.push('');

  if (response.results.length === 0) {
    lines.push('No matching entries found.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  // Format as simple list
  response.results.slice(0, 20).forEach((result, i) => {
    const title = result.title || result.name || result.path || `Entry ${i + 1}`;
    lines.push(`${i + 1}. **${title}**`);

    // Show a few properties
    const props = Object.keys(result).filter(k => !['title', 'name', 'path'].includes(k)).slice(0, 3);
    props.forEach(prop => {
      lines.push(property(prop, truncate(String(result[prop]), 40), 1));
    });
    lines.push('');
  });

  if (response.results.length > 20) {
    lines.push(`... and ${response.results.length - 20} more entries`);
  }

  lines.push(divider());
  lines.push(tip('Use filters to narrow down results'));
  lines.push(summaryFooter());

  return joinLines(lines);
}
