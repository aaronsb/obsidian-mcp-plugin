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
    let text: string;
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const filePath = obj.path ?? (obj.file as Record<string, unknown> | undefined)?.path;
      text = typeof filePath === 'string' ? filePath : JSON.stringify(item);
    } else {
      text = String(item);
    }
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

/**
 * Format bases.list response
 */
export interface BasesListResponse {
  bases: string[];
  count?: number;
}

export function formatBasesList(response: BasesListResponse | string[]): string {
  const lines: string[] = [];

  // Handle both array and object response
  const bases = Array.isArray(response) ? response : response.bases;
  const count = Array.isArray(response) ? response.length : (response.count ?? response.bases.length);

  lines.push(header(1, 'Available Bases'));
  lines.push('');
  lines.push(`Found ${count} base file${count !== 1 ? 's' : ''}`);
  lines.push('');

  if (bases.length === 0) {
    lines.push('No .base files found in vault.');
    lines.push('');
    lines.push(tip('Create a .base file to define a structured database'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  bases.slice(0, 30).forEach((base, i) => {
    const name = base.split('/').pop() || base;
    lines.push(`${i + 1}. ${name}`);
    lines.push(`   ${base}`);
  });

  if (bases.length > 30) {
    lines.push(`\n... and ${bases.length - 30} more`);
  }

  lines.push('');
  lines.push(divider());
  lines.push(tip('Use `bases.read(path)` to view a base configuration'));
  lines.push(tip('Use `bases.query(path)` to query data from a base'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format bases.read response
 */
export interface BasesReadResponse {
  path: string;
  config: {
    name?: string;
    source?: string;
    properties?: Record<string, unknown>;
    views?: unknown[];
  };
  raw?: string;
}

export function formatBasesRead(response: BasesReadResponse): string {
  const lines: string[] = [];

  const fileName = response.path.split('/').pop() || response.path;
  lines.push(header(1, `Base: ${fileName}`));
  lines.push('');
  lines.push(property('Path', response.path, 0));

  if (response.config.name) {
    lines.push(property('Name', response.config.name, 0));
  }
  if (response.config.source) {
    lines.push(property('Source', response.config.source, 0));
  }
  lines.push('');

  // Show properties
  if (response.config.properties && Object.keys(response.config.properties).length > 0) {
    lines.push(header(2, 'Properties'));
    Object.entries(response.config.properties).slice(0, 10).forEach(([key, value]) => {
      let displayValue: string;
      if (value === null || value === undefined) {
        displayValue = String(value);
      } else if (typeof value === 'object') {
        displayValue = JSON.stringify(value);
      } else {
        displayValue = String(value as string | number | boolean);
      }
      lines.push(property(key, truncate(displayValue, 50), 0));
    });
    if (Object.keys(response.config.properties).length > 10) {
      lines.push(`... and ${Object.keys(response.config.properties).length - 10} more properties`);
    }
    lines.push('');
  }

  // Show views count
  if (response.config.views && response.config.views.length > 0) {
    lines.push(property('Views', response.config.views.length.toString(), 0));
  }

  lines.push(divider());
  lines.push(tip('Use `bases.query(path)` to query data from this base'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format bases.create response
 */
export interface BasesCreateResponse {
  success: boolean;
  path: string;
  error?: string;
}

export function formatBasesCreate(response: BasesCreateResponse): string {
  const lines: string[] = [];

  const icon = response.success ? '✓' : '✗';
  lines.push(header(1, `${icon} Created Base`));
  lines.push('');

  if (response.success) {
    lines.push(`Base created successfully.`);
    lines.push('');
    lines.push(property('Path', response.path, 0));
    lines.push('');
    lines.push(tip('Use `bases.read(path)` to view the configuration'));
    lines.push(tip('Use `bases.query(path)` to query data'));
  } else {
    lines.push('Failed to create base.');
    if (response.error) {
      lines.push('');
      lines.push(property('Error', response.error, 0));
    }
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format bases.export response
 */
export interface BasesExportResponse {
  success: boolean;
  format: 'csv' | 'json' | 'markdown';
  data: string;
  rowCount?: number;
}

export function formatBasesExport(response: BasesExportResponse): string {
  const lines: string[] = [];

  const icon = response.success ? '✓' : '✗';
  lines.push(header(1, `${icon} Exported Base`));
  lines.push('');

  if (response.success) {
    lines.push(property('Format', response.format.toUpperCase(), 0));
    if (response.rowCount !== undefined) {
      lines.push(property('Rows', response.rowCount.toString(), 0));
    }
    lines.push('');

    lines.push(header(2, 'Data'));
    lines.push('');

    // Show preview of data
    const maxLength = 2000;
    if (response.data.length > maxLength) {
      lines.push('```');
      lines.push(response.data.substring(0, maxLength));
      lines.push('```');
      lines.push(`\n... (${response.data.length - maxLength} more characters)`);
    } else {
      lines.push('```');
      lines.push(response.data);
      lines.push('```');
    }
  } else {
    lines.push('Export failed.');
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}
