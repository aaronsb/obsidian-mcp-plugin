/**
 * Search result formatters
 */

import {
  header,
  property,
  truncate,
  interpretScore,
  divider,
  tip,
  summaryFooter,
  joinLines,
  formatPath
} from './utils';

export interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet?: {
    content: string;
    lineStart: number;
    lineEnd: number;
    score?: number;
  };
  metadata?: {
    size: number;
    modified: number;
    extension: string;
  };
}

export interface SearchResponse {
  query: string;
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  results: SearchResult[];
  method?: string;
}

/**
 * Format search results for AI consumption
 */
export function formatSearchResults(response: SearchResponse): string {
  const { query, page, pageSize, totalResults, totalPages, results } = response;
  const lines: string[] = [];

  // Header
  lines.push(header(1, `Search: "${query}"`));
  lines.push('');

  // Empty results
  if (totalResults === 0) {
    lines.push('No results found.');
    lines.push('');
    lines.push(tip('Try broader terms, use operators like `tag:#topic`, `file:name`, or `content:phrase`'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  // Summary line
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalResults);
  if (totalPages > 1) {
    lines.push(`Found ${totalResults} results (showing ${start}-${end}, page ${page} of ${totalPages})`);
  } else {
    lines.push(`Found ${totalResults} result${totalResults !== 1 ? 's' : ''}`);
  }
  lines.push('');

  // Results
  lines.push(header(2, 'Results'));
  lines.push('');

  results.forEach((result, i) => {
    const num = start + i;
    const scoreText = result.score > 0 ? ` (${interpretScore(result.score)})` : '';

    lines.push(`${num}. **${result.title}**${scoreText}`);
    lines.push(property('Path', formatPath(result.path)));

    if (result.snippet?.content) {
      const snippetText = truncate(result.snippet.content, 100);
      lines.push(property('Snippet', `"${snippetText}"`));
    }

    lines.push('');
  });

  // Tips
  lines.push(divider());

  if (page < totalPages) {
    lines.push(tip(`Use \`page: ${page + 1}\` for more results`));
  }

  lines.push(tip('Use `vault.read(path)` or `view.file(path)` to see full content'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format fragment results (vault.fragments action)
 * Supports both single-file and multi-file fragment results
 */
export interface FragmentItem {
  content: string;
  lineStart: number;
  lineEnd: number;
  heading?: string;
  score?: number;
}

export interface FileFragments {
  path: string;
  fragments: FragmentItem[];
  totalFragments: number;
}

export interface FragmentResult {
  // Multi-file format (from normalizer)
  files?: FileFragments[];
  totalResults?: number;
  query?: string;
  // Single-file format (legacy)
  path?: string;
  fragments?: FragmentItem[];
  totalFragments?: number;
}

export function formatFragmentResults(result: FragmentResult): string {
  const lines: string[] = [];

  // Handle multi-file format
  if (result.files && result.files.length > 0) {
    lines.push(header(1, 'Fragment Search Results'));
    lines.push('');
    lines.push(`Found ${result.totalResults || result.files.reduce((sum, f) => sum + f.fragments.length, 0)} fragments across ${result.files.length} files`);
    lines.push('');

    result.files.slice(0, 5).forEach((file, fileIdx) => {
      const fileName = file.path.split('/').pop() || file.path;
      lines.push(header(2, `${fileIdx + 1}. ${fileName}`));
      lines.push(`Path: ${file.path}`);
      lines.push('');

      file.fragments.slice(0, 3).forEach((frag, fragIdx) => {
        const scoreText = frag.score ? ` (score: ${frag.score.toFixed(2)})` : '';
        lines.push(`**Fragment ${fragIdx + 1}**${scoreText} - lines ${frag.lineStart}-${frag.lineEnd}`);
        lines.push('```');
        lines.push(truncate(frag.content, 300));
        lines.push('```');
        lines.push('');
      });

      if (file.fragments.length > 3) {
        lines.push(`... and ${file.fragments.length - 3} more fragments in this file`);
        lines.push('');
      }
    });

    if (result.files.length > 5) {
      lines.push(`... and ${result.files.length - 5} more files with matches`);
    }

    lines.push(divider());
    lines.push(tip('Use `vault.read(path)` to see full file content'));
    lines.push(tip('Use `view.window(path, lineNumber)` to see context around a specific line'));
    lines.push(summaryFooter());

    return joinLines(lines);
  }

  // Handle single-file format (legacy)
  if (result.path && result.fragments) {
    lines.push(header(1, `Fragments: ${result.path}`));
    lines.push('');
    lines.push(`Showing ${result.fragments.length} of ${result.totalFragments || result.fragments.length} fragments`);
    lines.push('');

    result.fragments.forEach((frag, i) => {
      const headingText = frag.heading ? ` (${frag.heading})` : '';
      lines.push(header(3, `Fragment ${i + 1}${headingText}`));
      lines.push(`Lines ${frag.lineStart}-${frag.lineEnd}`);
      lines.push('');
      lines.push('```');
      lines.push(truncate(frag.content, 500));
      lines.push('```');
      lines.push('');
    });

    lines.push(divider());
    lines.push(tip('Use `view.window(path, lineNumber)` to see context around a specific line'));
    lines.push(summaryFooter());

    return joinLines(lines);
  }

  // Fallback for unexpected format
  lines.push(header(1, 'Fragments'));
  lines.push('');
  lines.push('No fragments found or unexpected response format.');
  lines.push(summaryFooter());

  return joinLines(lines);
}
