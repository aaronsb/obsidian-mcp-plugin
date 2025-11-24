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
  content?: any;
  metadata?: any;
  originalContentLength?: number;
  fragmentMetadata?: {
    totalFragments: number;
    strategy: string;
    query: string;
  };
  workflow?: any;
  efficiency_hints?: any;
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
  // Check if it's an image file
  if (fileResponse && typeof fileResponse === 'object' && isImageFile(fileResponse)) {
    return fileResponse as FileReadResult;
  }

  // Extract content from the response
  let fileContent: string;
  let metadata: any = {};

  if (typeof fileResponse === 'string') {
    fileContent = fileResponse;
  } else if (fileResponse && typeof fileResponse === 'object' && 'content' in fileResponse) {
    // Handle structured response from Obsidian API
    fileContent = fileResponse.content;
    metadata = fileResponse;

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

    // Remove content from metadata if it exists there
    if (metadata && typeof metadata === 'object' && 'content' in metadata) {
      const { content, ...rest } = metadata;
      metadata = rest;
    }

    return {
      content: fileContent, // Ensure content is just the string
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
  await fragmentRetriever.indexDocument(docId, path, fileContent);

  // Retrieve relevant fragments based on query or path
  const fragmentQuery = query || path.split('/').pop()?.replace('.md', '') || '';
  const fragmentResponse = await fragmentRetriever.retrieveFragments(fragmentQuery, {
    strategy: strategy || 'auto',
    maxFragments: maxFragments || 5
  });

  // Return structured response with fragments
  return {
    ...metadata,
    content: fragmentResponse.result.fragments,
    originalContentLength: fileContent.length,
    fragmentMetadata: {
      totalFragments: fragmentResponse.result.totalFragments,
      strategy: strategy || 'auto',
      query: fragmentQuery
    }
    // workflow and efficiency_hints removed
  };
}