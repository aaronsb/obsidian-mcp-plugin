import { createHash } from 'crypto';
import { ensureStringContent } from './content-handler';

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
  
  for (const result of results as any[]) {
    // Create a minimal result object
    const minimalResult: any = {
      path: result.path || result.filename || '',
      title: result.title || result.basename || result.path?.split('/').pop()?.replace(/\.(md|png|jpg|jpeg|gif|svg|pdf|txt|json)$/i, '') || ''
    };

    // Add score if available
    if (typeof result.score === 'number') {
      minimalResult.score = result.score;
    }

    // Process content
    if (result.content || result.context) {
      const rawContent = result.content || result.context;
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
    return limitObjectResponse(response, config);
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
 * Limit object responses
 */
function limitObjectResponse(obj: any, config: ResponseLimiterConfig): any {
  const limited: any = {};
  let currentTokens = 2; // For object brackets

  // Prioritize certain keys
  const priorityKeys = ['error', 'message', 'path', 'title', 'query', 'page', 'totalResults'];
  const otherKeys = Object.keys(obj).filter(k => !priorityKeys.includes(k));
  const allKeys = [...priorityKeys.filter(k => k in obj), ...otherKeys];

  for (const key of allKeys) {
    if (!(key in obj)) continue;

    const value = obj[key];
    const entryStr = JSON.stringify({ [key]: value });
    const entryTokens = estimateTokens(entryStr);

    if (currentTokens + entryTokens > config.maxTokens) {
      // Try to add a truncation notice
      if (currentTokens + 50 < config.maxTokens) {
        limited._truncated = true;
      }
      break;
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
  
  const response: any = {
    results: paginatedResults,
    page,
    pageSize,
    totalResults,
    totalPages
  };

  // Add truncation metadata if results were limited
  if (truncated) {
    response.truncated = true;
    response.originalCount = originalCount;
    response.message = `Results limited to prevent token overflow. Showing ${limitedResults.length} of ${originalCount} total results.`;
  }

  return response;
}

/**
 * Paginate file list with metadata
 */
export function paginateFiles(
  files: any[],
  page: number = 1,
  pageSize: number = 20,
  directory?: string
): {
  files: any[];
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