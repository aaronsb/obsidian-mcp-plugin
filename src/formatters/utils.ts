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
 * Render a search score.
 *
 * Deliberately carries NO quality adjective. The score is TF-IDF — how often the query's
 * words occur, weighted by how rare they are — and it has no absolute scale: it means
 * different things for different queries and corpora. The old bands ("Good" ≥1.0, "Low"
 * >0) asserted a relevance judgement the number cannot support, and the failure was not
 * cosmetic. On a corpus where most notes mention the query term, every score compresses
 * into a narrow band: measured on a real vault, the single best-answering note scored
 * 1.42 while five other load-bearing notes scored 0.36-0.45 and were all labelled "Low".
 * An agent pruning at "Low" would have discarded the entire answer except the anchor.
 *
 * Showing the score as a share of the top hit makes that compression visible instead of
 * hiding it behind a word.
 */
export function interpretScore(score: number, topScore?: number): string {
  if (score <= 0) return 'match';

  const value = score.toFixed(2);
  if (topScore && topScore > 0 && score < topScore) {
    return `${value}, ${Math.round((score / topScore) * 100)}% of top hit`;
  }
  return value;
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
  // "Summary view" read as a truncation warning on tools whose job is faithful retrieval,
  // and callers spent real attention deciding whether the content they had been given was
  // lossy. Only metadata is abbreviated here; when content is actually truncated the
  // response says so in its own right (a Pagination section, or an explicit "N more"
  // line). Name the thing that is abbreviated instead of implying it might be the content.
  return '\n_Metadata fields are abbreviated; use `raw: true` for the full structured payload._';
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
 * Create a simple ASCII tree structure
 */
export function formatTree(items: string[], prefix: string = ''): string[] {
  return items.map((item, i) => {
    const isLast = i === items.length - 1;
    const marker = isLast ? '└── ' : '├── ';
    return prefix + marker + item;
  });
}
