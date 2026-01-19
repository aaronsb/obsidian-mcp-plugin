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
  context?: {
    fileContents?: Record<string, string>; // For search operations
    linkGraph?: Record<string, string[]>; // For graph operations
    metadata?: Record<string, unknown>; // Additional metadata
  };
}

interface WorkerResponse {
  id: string;
  type: 'result' | 'error';
  result?: unknown;
  error?: string;
}

/**
 * Process a semantic request in the worker thread
 */
async function processRequest(request: SemanticRequest, context?: any): Promise<any> {
  const { operation, action, params } = request;
  
  // For worker threads, we need to implement lightweight versions of operations
  // that don't depend on Obsidian's main thread APIs
  
  switch (operation) {
    case 'vault':
      return processVaultOperation(action, params, context);
    case 'graph':
      return processGraphOperation(action, params, context);
    default:
      throw new Error(`Worker: Unsupported operation ${operation}`);
  }
}

/**
 * Process vault operations that can be parallelized
 */
async function processVaultOperation(action: string, params: any, context?: any): Promise<any> {
  switch (action) {
    case 'search':
      // Implement file content searching logic
      if (!context?.fileContents) {
        throw new Error('File contents required for search operation');
      }
      return performBulkSearch(params, context.fileContents);
    case 'fragments':
      // Implement fragment extraction logic
      return extractFragments(params);
    default:
      throw new Error(`Worker: Unsupported vault action ${action}`);
  }
}

/**
 * Process graph operations that can be parallelized
 */
async function processGraphOperation(action: string, params: any, context?: any): Promise<any> {
  switch (action) {
    case 'search-traverse':
      // Implement graph traversal logic
      if (!context?.fileContents || !context?.linkGraph) {
        throw new Error('File contents and link graph required for graph traversal');
      }
      return performGraphTraversal({
        ...params,
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
async function performBulkSearch(params: any, fileContents: Record<string, string>): Promise<any> {
  const { query, page = 1, pageSize = 10 } = params;
  
  if (!query) {
    throw new Error('Query is required for search');
  }
  
  const allResults: unknown[] = [];
  
  // Search across all provided files
  for (const [filePath, content] of Object.entries(fileContents)) {
    const results = await performTextSearch({
      content,
      query,
      filePath,
      maxResults: 5 // Limit per file
    });
    
    allResults.push(...results);
  }
  
  // Sort all results by score
  allResults.sort((a: any, b: any) => b.score - a.score);
  
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
async function performTextSearch(params: any): Promise<any> {
  const { content, query, filePath, maxResults = 10 } = params;
  
  if (!content || !query) {
    throw new Error('Content and query are required for search');
  }
  
  const lines = content.split('\n');
  const results: unknown[] = [];
  const queryTerms = query.toLowerCase().split(/\s+/);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    
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
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Extract fragments from content
 */
async function extractFragments(params: any): Promise<any> {
  const { content, query, maxFragments = 5 } = params;
  
  if (!content) {
    throw new Error('Content is required for fragment extraction');
  }
  
  // Simple fragment extraction based on paragraphs
  const paragraphs = content.split(/\n\s*\n/);
  const fragments: unknown[] = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim();
    if (paragraph.length < 20) continue; // Skip very short paragraphs
    
    let score = 0;
    if (query) {
      // Score based on query relevance
      const queryTerms = query.toLowerCase().split(/\s+/);
      const paragraphLower = paragraph.toLowerCase();
      
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
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, maxFragments);
}

/**
 * Perform graph traversal operation
 */
async function performGraphTraversal(params: any): Promise<any> {
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
    const content = fileContents[current.path];
    if (content) {
      const searchResults = await performTextSearch({
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
        const links = linkGraph[current.path] || [];
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
          const result = await processRequest(request, context);
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