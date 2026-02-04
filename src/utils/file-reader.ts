import { ObsidianAPI } from './obsidian-api';
import { isImageFile } from '../types/obsidian';
import { UniversalFragmentRetriever } from '../indexing/fragment-retriever';

interface FileReadOptions {
  path: string;
  returnFullFile?: boolean;
  query?: string;
  strategy?: 'auto' | 'adaptive' | 'proximity' | 'semantic';
  maxFragments?: number;
}

interface FileReadResult {
  content?: unknown;
  metadata?: unknown;
  originalContentLength?: number;
  fragmentMetadata?: {
    totalFragments: number;
    strategy: string;
    query: string;
  };
  workflow?: unknown;
  efficiency_hints?: unknown;
  warning?: string;
  // For image files
  base64Data?: string;
  mimeType?: string;
}

/**
 * Shared file reading logic with fragment support
 * Used by both classic tools and semantic operations
 */
export async function readFileWithFragments(
  api: ObsidianAPI,
  fragmentRetriever: UniversalFragmentRetriever,
  options: FileReadOptions
): Promise<FileReadResult> {
  const { path, returnFullFile, query, strategy, maxFragments } = options;
  
  // Get the file
  const fileResponse = await api.getFile(path);
  
  // Check if it's an image file
  if (isImageFile(fileResponse)) {
    return fileResponse as FileReadResult;
  }
  
  // Extract content from the response
  let fileContent: string;
  let metadata: Record<string, unknown> = {};
  
  if (typeof fileResponse === 'string') {
    fileContent = fileResponse;
  } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
    // Handle structured response from Obsidian API
    fileContent = fileResponse.content;
    metadata = { ...fileResponse };
    
    // If it's still not a string (might be an image or binary file)
    if (typeof fileContent !== 'string') {
      return fileResponse as FileReadResult;
    }
  } else {
    // Handle other non-text files
    return fileResponse as FileReadResult;
  }
  
  // Return full file if requested
  if (returnFullFile) {
    const wordCount = fileContent.split(/\s+/).length;
    
    return {
      content: fileResponse,
      metadata: {
        ...metadata,
        wordCount,
        warning: wordCount > 2000 ? 
          `This file contains ${wordCount} words. Consider using fragment retrieval (remove returnFullFile parameter) to reduce context consumption.` : 
          null
      }
    };
  }
  
  // Use fragment retrieval
  const docId = `file:${path}`;
  fragmentRetriever.indexDocument(docId, path, fileContent);
  
  // Retrieve relevant fragments based on query or path
  const fragmentQuery = query || path.split('/').pop()?.replace('.md', '') || '';
  const fragmentResponse = fragmentRetriever.retrieveFragments(fragmentQuery, {
    strategy: strategy || 'auto',
    maxFragments: maxFragments || 5
  });
  
  // Return structured response with fragments
  return {
    ...metadata,
    content: fragmentResponse.result,
    originalContentLength: fileContent.length,
    fragmentMetadata: {
      totalFragments: fragmentResponse.result.length,
      strategy: strategy || 'auto',
      query: fragmentQuery
    },
    workflow: fragmentResponse.workflow,
    efficiency_hints: fragmentResponse.efficiency_hints
  };
}