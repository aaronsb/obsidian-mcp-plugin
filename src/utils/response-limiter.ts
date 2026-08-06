import { createHash } from 'crypto';
import { ensureStringContent } from './content-handler';

/**
 * Represents a search result item with optional fields
 */
interface SearchResultItem {
  path?: string;
  filename?: string;
  title?: string;
  basename?: string;
  score?: number;
  content?: string;
  context?: string;
}

/**
 * A processed/minimal search result
 */
interface MinimalResult {
  path: string;
  title: string;
  score?: number;
  preview?: string;
  contentHash?: string;
  contentLength?: number;
}

/**
 * Configuration for response limiting
 */
export interface ResponseLimiterConfig {
  maxTokens: number;
  contentPreviewLength: number;
  includeContentHash: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_LIMITER_CONFIG: ResponseLimiterConfig = {
  maxTokens: 20000,
  contentPreviewLength: 200,
  includeContentHash: true
};

/**
 * Estimates token count for a string (rough approximation)
 * Assumes ~4 characters per token on average
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generates a hash for content verification
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 8);
}

/**
 * Truncates content intelligently, preserving structure
 */
export function truncateContent(
  content: string, 
  maxLength: number,
  addEllipsis: boolean = true
): string {
  if (content.length <= maxLength) {
    return content;
  }
  
  // Try to break at a word boundary
  let truncated = content.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > maxLength * 0.8) {
    truncated = truncated.substring(0, lastSpace);
  }
  
  return addEllipsis ? truncated + '...' : truncated;
}

/**
 * Process search results to limit response size
 */
export function limitSearchResults(
  results: unknown[],
  config: ResponseLimiterConfig = DEFAULT_LIMITER_CONFIG
): {
  results: unknown[];
  truncated: boolean;
  originalCount: number;
} {
  const originalCount = results.length;
  let currentTokens = 0;
  const processedResults: unknown[] = [];
  let truncated = false;
  
  for (const rawResult of results) {
    // Treat each result as a SearchResultItem
    const result = rawResult as SearchResultItem;

    // Create a minimal result object
    const minimalResult: MinimalResult = {
      path: result.path || result.filename || '',
      title: result.title || result.basename || result.path?.split('/').pop()?.replace(/\.(md|png|jpg|jpeg|gif|svg|pdf|txt|json)$/i, '') || ''
    };

    // Add score if available
    if (typeof result.score === 'number') {
      minimalResult.score = result.score;
    }

    // Process content
    if (result.content || result.context) {
      const rawContent: unknown = result.content || result.context;
      // Ensure content is a string for truncation and hashing
      const fullContent = ensureStringContent(rawContent, 'response-limiter');
      const preview = truncateContent(fullContent, config.contentPreviewLength);
      minimalResult.preview = preview;

      if (config.includeContentHash) {
        minimalResult.contentHash = hashContent(fullContent);
      }

      // Store original content length for reference
      minimalResult.contentLength = fullContent.length;
    }

    // Estimate tokens for this result
    const resultJson = JSON.stringify(minimalResult);
    const resultTokens = estimateTokens(resultJson);

    // Check if adding this result would exceed limit
    if (currentTokens + resultTokens > config.maxTokens) {
      truncated = true;
      break;
    }

    processedResults.push(minimalResult);
    currentTokens += resultTokens;
  }
  
  return {
    results: processedResults,
    truncated,
    originalCount
  };
}

/**
 * Process any response to ensure it fits within token limits
 */
export function limitResponse(
  response: unknown,
  config: ResponseLimiterConfig = DEFAULT_LIMITER_CONFIG
): unknown {
  const responseStr = JSON.stringify(response);
  const tokens = estimateTokens(responseStr);
  
  if (tokens <= config.maxTokens) {
    return response;
  }
  
  // If response is too large, we need to truncate it
  if (Array.isArray(response)) {
    // Handle array responses
    return limitArrayResponse(response, config);
  } else if (typeof response === 'object' && response !== null) {
    // Handle object responses
    return limitObjectResponse(response as Record<string, unknown>, config);
  }
  
  // For other types, just truncate
  return truncateContent(String(response), config.maxTokens * 4);
}

/**
 * Limit array responses
 */
function limitArrayResponse(arr: unknown[], config: ResponseLimiterConfig): unknown[] {
  const limited: unknown[] = [];
  let currentTokens = 2; // For array brackets
  
  for (const item of arr) {
    const itemStr = JSON.stringify(item);
    const itemTokens = estimateTokens(itemStr);
    
    if (currentTokens + itemTokens > config.maxTokens) {
      break;
    }
    
    limited.push(item);
    currentTokens += itemTokens;
  }
  
  return limited;
}

/**
 * Shrink a value to fit a character budget, truncating long strings wherever
 * they sit — top level, inside an array, or nested in an object.
 *
 * The MCP tool-result shape puts an entire payload in one key as
 * `[{type:'text', text:'…'}]`, so a limiter that can only accept or reject
 * whole keys has exactly one move on a large page: drop everything. This gives
 * it a third option — return a shortened version of the same shape.
 */
function truncateToBudget(value: unknown, budgetChars: number): unknown {
  if (budgetChars <= 0) return undefined;

  if (typeof value === 'string') {
    return value.length <= budgetChars ? value : truncateContent(value, budgetChars);
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let remaining = budgetChars;
    for (const item of value) {
      const shrunk = truncateToBudget(item, remaining);
      if (shrunk === undefined) break;
      out.push(shrunk);
      remaining -= JSON.stringify(shrunk)?.length ?? 0;
      if (remaining <= 0) break;
    }
    return out;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let remaining = budgetChars;
    for (const [k, v] of Object.entries(value)) {
      const shrunk = truncateToBudget(v, remaining);
      if (shrunk === undefined) break;
      out[k] = shrunk;
      remaining -= JSON.stringify(shrunk)?.length ?? 0;
      if (remaining <= 0) break;
    }
    return out;
  }

  return value;
}

/**
 * Limit object responses
 */
function limitObjectResponse(obj: Record<string, unknown>, config: ResponseLimiterConfig): Record<string, unknown> {
  const limited: Record<string, unknown> = {};
  let currentTokens = 2; // For object brackets

  // Prioritize certain keys
  const priorityKeys = ['error', 'message', 'path', 'title', 'query', 'page', 'totalResults'];
  const otherKeys = Object.keys(obj).filter(k => !priorityKeys.includes(k));
  const allKeys = [...priorityKeys.filter(k => k in obj), ...otherKeys];

  for (const key of allKeys) {
    if (!(key in obj)) continue;

    const value: unknown = obj[key];
    const entryStr = JSON.stringify({ [key]: value });
    const entryTokens = estimateTokens(entryStr);

    if (currentTokens + entryTokens > config.maxTokens) {
      // Shrink the value to whatever budget is left rather than dropping the
      // key. Dropping it produced responses like `{_truncated: true}` with no
      // payload at all, which downstream formatters rendered as the literal
      // string "undefined" (#293) — a successful-looking call carrying nothing.
      // Reserve headroom for the marker and the key name itself.
      const remainingTokens = config.maxTokens - currentTokens - estimateTokens(key) - 20;
      const shrunk = remainingTokens > 0 ? truncateToBudget(value, remainingTokens * 4) : undefined;
      if (shrunk !== undefined) {
        limited[key] = shrunk;
        currentTokens += estimateTokens(JSON.stringify(shrunk));
      }
      limited._truncated = true;
      // Keep going: a later key may still be small enough to fit, and the key
      // order here is priority-first, so stopping would discard cheap
      // high-value fields because one big one arrived ahead of them.
      continue;
    }

    limited[key] = value;
    currentTokens += entryTokens;
  }

  return limited;
}

/**
 * Paginate array data with token limits
 */
export function paginateResults<T>(
  data: T[],
  page: number = 1,
  pageSize: number = 10,
  config: ResponseLimiterConfig = DEFAULT_LIMITER_CONFIG
): {
  results: T[];
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  truncated?: boolean;
  originalCount?: number;
  message?: string;
} {
  // First limit results to prevent token overflow
  const { results: limitedResults, truncated, originalCount } = limitSearchResults(data, config);
  
  const totalResults = limitedResults.length;
  const totalPages = Math.ceil(totalResults / pageSize);
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  
  const paginatedResults = limitedResults.slice(startIndex, endIndex);
  
  return {
    results: paginatedResults as T[],
    page,
    pageSize,
    totalResults,
    totalPages,
    ...(truncated ? {
      truncated: true,
      originalCount,
      message: `Results limited to prevent token overflow. Showing ${limitedResults.length} of ${originalCount} total results.`
    } : {})
  };
}

/**
 * Paginate file list with metadata
 */
export function paginateFiles<T>(
  files: T[],
  page: number = 1,
  pageSize: number = 20,
  directory?: string
): {
  files: T[];
  page: number;
  pageSize: number;
  totalFiles: number;
  totalPages: number;
  directory?: string;
} {
  const totalFiles = files.length;
  const totalPages = Math.ceil(totalFiles / pageSize);
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  
  const paginatedFiles = files.slice(startIndex, endIndex);
  
  return {
    files: paginatedFiles,
    page,
    pageSize,
    totalFiles,
    totalPages,
    ...(directory && { directory })
  };
}