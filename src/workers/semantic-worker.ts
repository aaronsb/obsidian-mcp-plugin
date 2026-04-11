import { parentPort } from 'worker_threads';
import { SemanticRequest } from '../types/semantic';

/**
 * Worker thread for processing semantic operations
 * This runs in a separate thread to avoid blocking the main thread
 *
 * Note: Workers cannot directly access Obsidian APIs, so they receive
 * pre-fetched data from the main thread and perform CPU-intensive
 * processing like searching, scoring, and traversal.
 */

// Message types for worker communication
interface WorkerMessage {
  id: string;
  type: 'process' | 'shutdown';
  request?: SemanticRequest;
  // Additional data passed from main thread
  context?: WorkerContext;
}

interface WorkerContext {
  fileContents?: Record<string, string>; // For search operations
  linkGraph?: Record<string, string[]>; // For graph operations
  metadata?: Record<string, unknown>; // Additional metadata
}

interface WorkerResponse {
  id: string;
  type: 'result' | 'error';
  result?: unknown;
  error?: string;
}

/** Search result from text search */
interface TextSearchResult {
  path?: string;
  lineNumber: number;
  line: string;
  score: number;
  matchedTerms: number;
  context: string;
}

/** Fragment extracted from content */
interface FragmentResult {
  text: string;
  score: number;
  position: number;
  length: number;
}

/** Parameters for bulk search */
interface BulkSearchParams {
  query?: string;
  page?: number;
  pageSize?: number;
}

/** Parameters for text search */
interface TextSearchParams {
  content: string;
  query: string;
  filePath?: string;
  maxResults?: number;
}

/** Parameters for fragment extraction */
interface FragmentParams {
  content?: string;
  query?: string;
  maxFragments?: number;
}

/** Parameters for graph traversal */
interface GraphTraversalParams {
  startNode: string;
  searchQuery: string;
  fileContents: Record<string, string>;
  linkGraph: Record<string, string[]>;
  maxDepth?: number;
  scoreThreshold?: number;
}

/** Bulk search response */
interface BulkSearchResponse {
  query: string;
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  results: unknown[];
  method: string;
}

/** Graph traversal response */
interface GraphTraversalResponse {
  traversalChain: unknown[];
  nodesVisited: number;
}

interface WorkerFuzzyMatch {
  line: string;
  lineNumber: number;
  similarity: number;
}

/**
 * Process a semantic request in the worker thread
 */
function processRequest(request: SemanticRequest, context?: WorkerContext): unknown {
  const { operation, action, params } = request;

  // For worker threads, we need to implement lightweight versions of operations
  // that don't depend on Obsidian's main thread APIs

  switch (operation) {
    case 'vault':
      return processVaultOperation(action, params, context);
    case 'graph':
      return processGraphOperation(action, params, context);
    case 'edit':
      return processEditOperation(action, params, context);
    default:
      throw new Error(`Worker: Unsupported operation ${operation}`);
  }
}

/**
 * Process edit operations that can be parallelized
 */
function processEditOperation(action: string, params: Record<string, unknown>, context?: WorkerContext): unknown {
  const { path, oldText, newText, fuzzyThreshold = 0.7 } = params;
  
  if (!context?.fileContents || !context.fileContents[path as string]) {
    throw new Error(`File contents for ${path} required for edit operation`);
  }
  
  const content = context.fileContents[path as string];

  switch (action) {
    case 'window':
    case 'from_buffer': {
      const searchText = (oldText as string) || '';
      const replacementText = (newText as string) || '';
      
      // Local implementation of performWindowEdit for worker
      
      // 1. Try exact match first
      if (content.includes(searchText)) {
        const newContent = content.replace(searchText, replacementText);
        return {
          success: true,
          newContent,
          method: 'exact'
        };
      }
      
      // 2. Try fuzzy matching
      // We implement a simplified version of findFuzzyMatches here to avoid extra imports in compiled worker
      const threshold = Number(fuzzyThreshold);
      const matches = workerFindFuzzyMatches(content, searchText, threshold);
      
      if (matches.length === 0) {
        return {
          success: false,
          error: 'NO_MATCH',
          message: `No matches found for "${searchText}" in ${path}`
        };
      }
      
      if (matches.length > 1) {
        return {
          success: false,
          error: 'MULTIPLE_MATCHES',
          matches: matches.map(m => ({
            lineNumber: m.lineNumber,
            line: m.line,
            similarity: m.similarity
          }))
        };
      }
      
      // Single match found
      const match = matches[0];
      const lines = content.split('\n');
      lines[match.lineNumber - 1] = replacementText;
      const newContent = lines.join('\n');
      
      return {
        success: true,
        newContent,
        lineNumber: match.lineNumber,
        similarity: match.similarity,
        method: 'fuzzy'
      };
    }
    default:
      throw new Error(`Worker: Unsupported edit action ${action}`);
  }
}

/**
 * Lightweight fuzzy matching for worker thread
 */
function workerFindFuzzyMatches(content: string, searchText: string, threshold: number): WorkerFuzzyMatch[] {
  const lines = content.split('\n');
  const matches: WorkerFuzzyMatch[] = [];
  const normalizedSearch = searchText.toLowerCase().trim();
  const searchWords = normalizedSearch.split(/\s+/).filter(w => w.length > 0);
  
  if (searchWords.length === 0) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const normalizedLine = line.toLowerCase();
    
    if (normalizedLine.includes(normalizedSearch)) {
      matches.push({ line, lineNumber: i + 1, similarity: 1.0 });
      continue;
    }
    
    if (normalizedLine.length < normalizedSearch.length * threshold * 0.8) continue;

    let bestSimilarity = 0;
    const words = line.split(/\s+/).filter(w => w.length > 0);
    
    for (let start = 0; start < words.length; start++) {
      const maxEnd = Math.min(words.length, start + searchWords.length + 3);
      for (let end = start + 1; end <= maxEnd; end++) {
        const phrase = words.slice(start, end).join(' ');
        
        if (Math.abs(phrase.length - normalizedSearch.length) > normalizedSearch.length * (1 - threshold) + 2) {
          continue;
        }

        const similarity = workerCalculateSimilarity(phrase, normalizedSearch);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          if (bestSimilarity >= 0.95) break;
        }
      }
      if (bestSimilarity >= 0.95) break;
    }
    
    if (bestSimilarity >= threshold) {
      matches.push({ line, lineNumber: i + 1, similarity: bestSimilarity });
    }
  }
  
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

function workerCalculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  
  let prevRow = new Int32Array(str2.length + 1);
  let currRow = new Int32Array(str2.length + 1);
  for (let i = 0; i <= str2.length; i++) prevRow[i] = i;

  for (let i = 1; i <= str1.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= str2.length; j++) {
      if (str1[i - 1] === str2[j - 1]) currRow[j] = prevRow[j - 1];
      else currRow[j] = Math.min(prevRow[j - 1] + 1, currRow[j - 1] + 1, prevRow[j] + 1);
    }
    [prevRow, currRow] = [currRow, prevRow];
  }
  return 1 - (prevRow[str2.length] / maxLength);
}


/**
 * Process vault operations that can be parallelized
 */
function processVaultOperation(action: string, params: Record<string, unknown>, context?: WorkerContext): unknown {
  switch (action) {
    case 'search':
      // Implement file content searching logic
      if (!context?.fileContents) {
        throw new Error('File contents required for search operation');
      }
      return performBulkSearch(params as unknown as BulkSearchParams, context.fileContents);
    case 'fragments':
      // Implement fragment extraction logic
      return extractFragments(params as unknown as FragmentParams);
    default:
      throw new Error(`Worker: Unsupported vault action ${action}`);
  }
}

/**
 * Process graph operations that can be parallelized
 */
function processGraphOperation(action: string, params: Record<string, unknown>, context?: WorkerContext): unknown {
  switch (action) {
    case 'search-traverse':
      // Implement graph traversal logic
      if (!context?.fileContents || !context?.linkGraph) {
        throw new Error('File contents and link graph required for graph traversal');
      }
      return performGraphTraversal({
        ...(params as unknown as Omit<GraphTraversalParams, 'fileContents' | 'linkGraph'>),
        fileContents: context.fileContents,
        linkGraph: context.linkGraph
      });
    default:
      throw new Error(`Worker: Unsupported graph action ${action}`);
  }
}

/**
 * Perform bulk search across multiple files
 * This is a CPU-intensive operation perfect for worker threads
 */
function performBulkSearch(params: BulkSearchParams, fileContents: Record<string, string>): BulkSearchResponse {
  const { query, page = 1, pageSize = 10 } = params;

  if (!query) {
    throw new Error('Query is required for search');
  }

  const allResults: TextSearchResult[] = [];

  // Search across all provided files
  for (const [filePath, content] of Object.entries(fileContents)) {
    const results = performTextSearch({
      content,
      query,
      filePath,
      maxResults: 5 // Limit per file
    });

    allResults.push(...results);
  }

  // Sort all results by score
  allResults.sort((a: TextSearchResult, b: TextSearchResult) => b.score - a.score);

  // Apply pagination
  const totalResults = allResults.length;
  const totalPages = Math.ceil(totalResults / pageSize);
  const startIndex = (page - 1) * pageSize;
  const paginatedResults = allResults.slice(startIndex, startIndex + pageSize);

  return {
    query,
    page,
    pageSize,
    totalResults,
    totalPages,
    results: paginatedResults,
    method: 'worker-thread'
  };
}

/**
 * Extract context around a line
 */
function extractLineContext(lines: string[], lineIndex: number, contextSize: number = 2): string {
  const start = Math.max(0, lineIndex - contextSize);
  const end = Math.min(lines.length, lineIndex + contextSize + 1);
  return lines.slice(start, end).join('\n');
}

/**
 * Perform text search operation on a single file
 * This is a CPU-intensive operation perfect for worker threads
 */
function performTextSearch(params: TextSearchParams): TextSearchResult[] {
  const { content, query, filePath, maxResults = 10 } = params;

  if (!content || !query) {
    throw new Error('Content and query are required for search');
  }

  const lines: string[] = content.split('\n');
  const results: TextSearchResult[] = [];
  const queryTerms: string[] = query.toLowerCase().split(/\s+/);

  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    const lineLower: string = line.toLowerCase();

    let score = 0;
    let matchedTerms = 0;

    for (const term of queryTerms) {
      if (lineLower.includes(term)) {
        matchedTerms++;
        // Exact word match gets higher score
        const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (wordBoundaryRegex.test(line)) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }

    if (matchedTerms > 0) {
      const normalizedScore = score / (queryTerms.length * 2);
      results.push({
        path: filePath,
        lineNumber: i + 1,
        line: line.trim(),
        score: normalizedScore,
        matchedTerms,
        context: extractLineContext(lines, i)
      });
    }
  }

  // Sort by score and return top results
  return results
    .sort((a: TextSearchResult, b: TextSearchResult) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Extract fragments from content
 */
function extractFragments(params: FragmentParams): FragmentResult[] {
  const { content, query, maxFragments = 5 } = params;

  if (!content) {
    throw new Error('Content is required for fragment extraction');
  }

  // Simple fragment extraction based on paragraphs
  const paragraphs: string[] = content.split(/\n\s*\n/);
  const fragments: FragmentResult[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph: string = paragraphs[i].trim();
    if (paragraph.length < 20) continue; // Skip very short paragraphs

    let score = 0;
    if (query) {
      // Score based on query relevance
      const queryTerms: string[] = query.toLowerCase().split(/\s+/);
      const paragraphLower: string = paragraph.toLowerCase();

      for (const term of queryTerms) {
        if (paragraphLower.includes(term)) {
          score += 1;
        }
      }

      score = score / queryTerms.length;
    } else {
      // Default scoring based on position and length
      score = 1 - (i / paragraphs.length) * 0.5; // Earlier paragraphs score higher
    }

    fragments.push({
      text: paragraph,
      score,
      position: i,
      length: paragraph.length
    });
  }

  // Sort by score and return top fragments
  return fragments
    .sort((a: FragmentResult, b: FragmentResult) => b.score - a.score)
    .slice(0, maxFragments);
}

/**
 * Perform graph traversal operation
 */
function performGraphTraversal(params: GraphTraversalParams): GraphTraversalResponse {
  const {
    startNode,
    searchQuery,
    fileContents,
    linkGraph,
    maxDepth = 3,
    scoreThreshold = 0.5
  } = params;

  if (!fileContents || !linkGraph) {
    throw new Error('File contents and link graph are required for traversal');
  }

  const visited = new Set<string>();
  const traversalChain: unknown[] = [];
  const queue: Array<{ path: string; depth: number; parent?: string }> = [
    { path: startNode, depth: 0 }
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current.path) || current.depth > maxDepth) {
      continue;
    }

    visited.add(current.path);

    // Search in current file content
    const content: string | undefined = fileContents[current.path];
    if (content) {
      const searchResults: TextSearchResult[] = performTextSearch({
        content,
        query: searchQuery,
        maxResults: 2
      });

      if (searchResults.length > 0 && searchResults[0].score >= scoreThreshold) {
        traversalChain.push({
          path: current.path,
          depth: current.depth,
          parent: current.parent,
          snippet: searchResults[0]
        });

        // Add linked files to queue
        const links: string[] = linkGraph[current.path] || [];
        for (const linkedPath of links) {
          if (!visited.has(linkedPath)) {
            queue.push({
              path: linkedPath,
              depth: current.depth + 1,
              parent: current.path
            });
          }
        }
      }
    }
  }

  return {
    traversalChain,
    nodesVisited: visited.size
  };
}


// Worker message handling
if (parentPort) {
  parentPort.on('message', (message: WorkerMessage) => {
    void (async () => {
      const { id, type, request, context } = message;

      if (type === 'shutdown') {
        process.exit(0);
      }

      try {
        if (type === 'process' && request) {
          const result: unknown = processRequest(request, context);
          const response: WorkerResponse = {
            id,
            type: 'result',
            result
          };
          parentPort!.postMessage(response);
        }
      } catch (error) {
        const response: WorkerResponse = {
          id,
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        };
        parentPort!.postMessage(response);
      }
    })();
  });

  // Send ready signal
  parentPort.postMessage({ type: 'ready' });
}
