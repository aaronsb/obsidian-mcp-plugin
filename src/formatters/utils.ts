/**
 * Shared formatting utilities for presentation facade
 *
 * These utilities convert raw API responses into AI-readable markdown.
 */

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLen: number = 120): string {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

/**
 * Interpret a relevance score as a human-readable label
 */
export function interpretScore(score: number): string {
  if (score >= 2.0) return `Excellent (${score.toFixed(2)})`;
  if (score >= 1.0) return `Good (${score.toFixed(2)})`;
  if (score >= 0.5) return `Moderate (${score.toFixed(2)})`;
  if (score > 0) return `Low (${score.toFixed(2)})`;
  return `Match`;
}

/**
 * Format a file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a timestamp as a relative or absolute date
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

/**
 * Create a markdown header
 */
export function header(level: number, text: string): string {
  return '#'.repeat(Math.min(level, 6)) + ' ' + text;
}

/**
 * Create a numbered list item
 */
export function listItem(index: number, text: string, indent: number = 0): string {
  const padding = '   '.repeat(indent);
  return `${padding}${index}. ${text}`;
}

/**
 * Create an indented property line
 */
export function property(name: string, value: string | number, indent: number = 1): string {
  const padding = '   '.repeat(indent);
  return `${padding}${name}: ${value}`;
}

/**
 * Join lines with proper spacing
 */
export function joinLines(...lines: (string | string[])[]): string {
  return lines
    .flat()
    .filter(line => line !== undefined && line !== null)
    .join('\n');
}

/**
 * Add the standard footer hint about raw mode
 */
export function summaryFooter(): string {
  return '\n_Summary view. For all metadata fields, use `raw: true`._';
}

/**
 * Format a horizontal rule with optional tip
 */
export function divider(): string {
  return '\n---';
}

/**
 * Format a tip line
 */
export function tip(text: string): string {
  return `Tip: ${text}`;
}

/**
 * Escape markdown special characters in user content
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`[\]])/g, '\\$1');
}

/**
 * Format a path for display (shorten if too long)
 */
export function formatPath(path: string, maxLen: number = 60): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return truncate(path, maxLen);
  return `${parts[0]}/.../${parts[parts.length - 1]}`;
}

/**
 * Create a simple ASCII tree structure
 */
export function formatTree(items: string[], prefix: string = ''): string[] {
  return items.map((item, i) => {
    const isLast = i === items.length - 1;
    const marker = isLast ? '└── ' : '├── ';
    return prefix + marker + item;
  });
}
