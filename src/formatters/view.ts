/**
 * View operation formatters
 */

import {
  header,
  property,
  divider,
  tip,
  summaryFooter,
  joinLines
} from './utils';

/**
 * Format view.file response (full document view)
 * Actual response: { path, content, tags, frontmatter }
 */
export interface ViewFileResponse {
  path: string;
  content: string;
  lineCount?: number;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export function formatViewFile(response: ViewFileResponse): string {
  const lines: string[] = [];

  const fileName = response.path.split('/').pop() || response.path;
  const lineCount = response.lineCount ?? response.content.split('\n').length;

  lines.push(header(1, `View: ${fileName}`));
  lines.push('');
  lines.push(property('Path', response.path, 0));
  lines.push(property('Lines', lineCount.toString(), 0));

  // Show tags if present
  if (response.tags && response.tags.length > 0) {
    lines.push(property('Tags', response.tags.join(', '), 0));
  }

  // Show frontmatter keys if present
  if (response.frontmatter && Object.keys(response.frontmatter).length > 0) {
    lines.push(property('Frontmatter', Object.keys(response.frontmatter).join(', '), 0));
  }
  lines.push('');

  lines.push('```markdown');
  lines.push(response.content);
  lines.push('```');

  lines.push(divider());
  lines.push(tip('Use `edit.window(path, oldText, newText)` to make changes'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format view.window response (windowed view around a line)
 * Actual response: { path, lines[], startLine, endLine, totalLines, centerLine }
 */
export interface ViewWindowResponse {
  path: string;
  content?: string;
  lines?: string[];
  lineStart?: number;
  lineEnd?: number;
  startLine?: number;
  endLine?: number;
  totalLines: number;
  centerLine?: number;
  searchText?: string;
}

export function formatViewWindow(response: ViewWindowResponse): string {
  const lines: string[] = [];

  const fileName = response.path.split('/').pop() || response.path;
  // Handle both naming conventions
  const startLine = response.startLine ?? response.lineStart ?? 1;
  const endLine = response.endLine ?? response.lineEnd ?? response.totalLines;

  lines.push(header(1, `View: ${fileName}`));
  lines.push('');
  lines.push(property('Path', response.path, 0));
  lines.push(property('Showing', `lines ${startLine}-${endLine} of ${response.totalLines}`, 0));

  if (response.centerLine) {
    lines.push(property('Center', `line ${response.centerLine}`, 0));
  }
  if (response.searchText) {
    lines.push(property('Search', `"${response.searchText}"`, 0));
  }
  lines.push('');

  // Get content lines - handle both formats
  let contentLines: string[];
  if (response.lines && Array.isArray(response.lines)) {
    contentLines = response.lines;
  } else if (response.content) {
    contentLines = response.content.split('\n');
  } else {
    contentLines = [];
  }

  // Add line numbers to content
  const numberedContent = contentLines
    .map((line, i) => {
      const lineNum = startLine + i;
      const padding = String(endLine).length;
      return `${String(lineNum).padStart(padding)} | ${line}`;
    })
    .join('\n');

  lines.push('```');
  lines.push(numberedContent);
  lines.push('```');

  lines.push(divider());

  // Navigation tips
  const tipLines: string[] = [];
  if (startLine > 1) {
    tipLines.push(tip(`Use \`lineNumber: ${Math.max(1, startLine - 20)}\` to see earlier content`));
  }
  if (endLine < response.totalLines) {
    tipLines.push(tip(`Use \`lineNumber: ${endLine + 1}\` to see later content`));
  }
  tipLines.push(tip('Use `edit.window(path, oldText, newText)` to make changes'));

  lines.push(tipLines.join('\n'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format view.active response (currently open file)
 * Actual response: { path, content, tags, frontmatter }
 */
export interface ViewActiveResponse {
  path: string;
  content: string;
  lineCount?: number;
  cursorLine?: number;
  cursorColumn?: number;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export function formatViewActive(response: ViewActiveResponse): string {
  const lines: string[] = [];

  if (!response.path) {
    lines.push(header(1, 'Active File'));
    lines.push('');
    lines.push('No file is currently open in the editor.');
    return joinLines(lines);
  }

  const fileName = response.path.split('/').pop() || response.path;
  const contentLines = response.content.split('\n');
  const lineCount = response.lineCount ?? contentLines.length;

  lines.push(header(1, `Active: ${fileName}`));
  lines.push('');
  lines.push(property('Path', response.path, 0));
  lines.push(property('Lines', lineCount.toString(), 0));

  // Show tags if present
  if (response.tags && response.tags.length > 0) {
    lines.push(property('Tags', response.tags.join(', '), 0));
  }

  // Show frontmatter keys if present
  if (response.frontmatter && Object.keys(response.frontmatter).length > 0) {
    lines.push(property('Frontmatter', Object.keys(response.frontmatter).join(', '), 0));
  }

  if (response.cursorLine !== undefined) {
    lines.push(property('Cursor', `line ${response.cursorLine}, column ${response.cursorColumn || 0}`, 0));
  }
  lines.push('');

  // Show content preview
  const previewLines = contentLines.slice(0, 100);

  lines.push('```markdown');
  lines.push(previewLines.join('\n'));
  if (contentLines.length > 100) {
    lines.push(`\n... (${contentLines.length - 100} more lines)`);
  }
  lines.push('```');

  lines.push(divider());
  lines.push(tip('Use `view.window(path, lineNumber)` to focus on a specific section'));
  lines.push(summaryFooter());

  return joinLines(lines);
}
