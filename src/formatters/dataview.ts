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
  values?: DataviewValue[];
  headers?: string[];
  successful: boolean;
  error?: string;
}

type DataviewValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

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

function formatDataviewTable(headers: string[], rows: DataviewValue[]): string {
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
      let val: unknown;
      if (Array.isArray(row)) {
        val = row[i];
      } else if (row !== null && typeof row === 'object') {
        val = row[headers[i]];
      }
      let display: string;
      if (val === null || val === undefined) {
        display = '';
      } else if (typeof val === 'object') {
        display = JSON.stringify(val);
      } else {
        const primitive = val as string | number | boolean | bigint | symbol;
        display = String(primitive);
      }
      return truncate(display, 30);
    });
    lines.push('| ' + cells.join(' | ') + (hasMore ? ' | ...' : '') + ' |');
  });

  if (rows.length > 20) {
    lines.push(`\n... and ${rows.length - 20} more rows`);
  }

  return lines.join('\n');
}

function formatDataviewList(items: DataviewValue[]): string {
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

interface DataviewTask {
  completed?: boolean;
  text?: string;
  task?: string;
  path?: string;
}

function formatDataviewTasks(tasks: DataviewValue[]): string {
  const lines: string[] = [];

  tasks.slice(0, 30).forEach(taskItem => {
    const task = (taskItem !== null && typeof taskItem === 'object' && !Array.isArray(taskItem)
      ? taskItem
      : {}) as DataviewTask;
    const checkbox = task.completed ? '[x]' : '[ ]';
    const taskString = taskItem !== null && typeof taskItem === 'object'
      ? JSON.stringify(taskItem)
      : String(taskItem);
    const text = task.text || task.task || taskString;
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
 * Format dataview.list response
 *
 * `listPages()` returns `{ success, source, count, pages: [...] }`, not the
 * `{ values }` shape `formatDataviewQuery` reads — routing it through the query
 * formatter always hit the `!values` branch and rendered "No results found"
 * regardless of data (#220). A page list isn't really a query result, so it
 * gets its own formatter.
 */
export interface DataviewPagesResponse {
  success: boolean;
  source?: string;
  count?: number;
  pages?: Array<Record<string, unknown>>;
  error?: string;
}

export function formatDataviewPages(response: DataviewPagesResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Dataview: Pages'));
  lines.push('');
  lines.push(property('Source', response.source ?? 'all', 0));

  if (response.success === false) {
    lines.push('');
    lines.push(`❌ Query failed: ${response.error || 'Unknown error'}`);
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  const pages = response.pages ?? [];
  const total = response.count ?? pages.length;
  lines.push(property('Count', String(total), 0));
  lines.push('');

  if (pages.length === 0) {
    lines.push('No pages found.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  pages.slice(0, 30).forEach((page, i) => {
    const path = typeof page.path === 'string' ? page.path : JSON.stringify(page);
    lines.push(`${i + 1}. ${truncate(path, 60)}`);
  });

  if (total > 30) {
    lines.push(`\n... and ${total - 30} more pages`);
  }

  lines.push(divider());
  lines.push(tip('Use `dataview.metadata(path)` for one page, or `vault.read(path)` to open it'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format dataview.metadata response
 *
 * `getPageMetadata()` returns `{ success, path, metadata: {...} }` — same #220
 * shape mismatch as the page list. A single page's metadata is not a query
 * result either, so it gets a dedicated formatter rather than the `{ values }`
 * query path.
 */
export interface DataviewMetadataResponse {
  success: boolean;
  path: string;
  metadata?: {
    file?: Record<string, unknown>;
    tags?: unknown[];
    aliases?: unknown[];
    outlinks?: unknown[];
    inlinks?: unknown[];
    tasks?: number;
    lists?: number;
    custom?: Record<string, unknown>;
  };
  error?: string;
}

export function formatDataviewMetadata(response: DataviewMetadataResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Dataview: Metadata'));
  lines.push('');
  lines.push(property('Path', response.path, 0));

  if (response.success === false || !response.metadata) {
    lines.push('');
    lines.push(`❌ ${response.error || 'No metadata available'}`);
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  const m = response.metadata;
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const aliases = Array.isArray(m.aliases) ? m.aliases : [];
  const outlinks = Array.isArray(m.outlinks) ? m.outlinks : [];
  const inlinks = Array.isArray(m.inlinks) ? m.inlinks : [];

  lines.push('');
  if (tags.length > 0) {
    lines.push(property('Tags', tags.map(t => String(t)).join(', '), 0));
  }
  if (aliases.length > 0) {
    lines.push(property('Aliases', aliases.map(a => String(a)).join(', '), 0));
  }
  lines.push(property('Outlinks', String(outlinks.length), 0));
  lines.push(property('Inlinks', String(inlinks.length), 0));
  lines.push(property('Tasks', String(m.tasks ?? 0), 0));
  lines.push(property('Lists', String(m.lists ?? 0), 0));

  const custom = (m.custom && typeof m.custom === 'object') ? m.custom : {};
  const customKeys = Object.keys(custom);
  if (customKeys.length > 0) {
    lines.push('');
    lines.push(header(2, 'Frontmatter'));
    customKeys.slice(0, 15).forEach(key => {
      const value = custom[key];
      let display: string;
      if (value === null || value === undefined) {
        display = String(value);
      } else if (typeof value === 'object') {
        display = JSON.stringify(value);
      } else {
        const primitive = value as string | number | boolean | bigint | symbol;
        display = String(primitive);
      }
      lines.push(property(key, truncate(display, 50), 0));
    });
    if (customKeys.length > 15) {
      lines.push(`... and ${customKeys.length - 15} more fields`);
    }
  }

  lines.push(divider());
  lines.push(tip('Use `vault.read(path)` to view the full note'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format bases.query response
 */
interface BasesQueryResult {
  title?: string;
  name?: string;
  path?: string;
  [key: string]: unknown;
}

export interface BasesQueryResponse {
  basePath: string;
  results: BasesQueryResult[];
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
        const primitive = value as string | number | boolean | bigint | symbol;
        displayValue = String(primitive);
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
