import { Fragment } from '../types/fragment';

/**
 * Safely ensures content is converted to string format
 * Handles various input types including Fragment arrays, Buffers, and objects
 */
export function ensureStringContent(content: unknown, context?: string): string {
  try {
    // Handle null/undefined
    if (content == null) {
      return '';
    }
    
    // Already a string
    if (typeof content === 'string') {
      return content;
    }
    
    // Handle Buffer (common in Node.js file operations)
    if (Buffer.isBuffer(content)) {
      return content.toString('utf-8');
    }
    
    // Handle ArrayBuffer
    if (content instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(content);
    }
    
    // Handle Uint8Array and similar typed arrays
    if (content instanceof Uint8Array) {
      return new TextDecoder('utf-8').decode(content);
    }
    
    // Handle Fragment array - extract text content from each fragment
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (typeof item === 'string') {
            return item;
          }
          // Fragment objects may have content, text, or data properties
          const fragmentText = (item as any)?.content || (item as any)?.text || (item as any)?.data || '';
          return typeof fragmentText === 'string' ? fragmentText : '';
        })
        .filter(text => text.length > 0)
        .join('\n');
    }
    
    // Handle objects with toString method
    if (typeof content === 'object' && content !== null && 'toString' in content) {
      return content.toString();
    }
    
    // Fallback: convert to string
    return String(content);
    
  } catch (error) {
    console.warn(`Content conversion failed${context ? ` in ${context}` : ''}:`, {
      contentType: typeof content,
      contentConstructor: content?.constructor?.name,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return '';
  }
}

/**
 * Safely performs regex match operations on content that may not be a string
 * Returns match results or null, handling type conversion automatically
 */
export function safeContentMatch(
  content: unknown, 
  pattern: RegExp, 
  context?: string
): RegExpMatchArray | null {
  try {
    const stringContent = ensureStringContent(content, context);
    
    if (!stringContent) {
      return null;
    }
    
    return stringContent.match(pattern);
    
  } catch (error) {
    console.warn(`Match operation failed${context ? ` in ${context}` : ''}:`, {
      pattern: pattern.toString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return null;
  }
}

/**
 * Safely count matches in content, handling type conversion
 * Specifically designed for counting links, tags, and other patterns
 */
export function safeCountMatches(
  content: unknown,
  pattern: RegExp,
  context?: string
): number {
  const matches = safeContentMatch(content, pattern, context);
  return matches ? matches.length : 0;
}

/**
 * Handle Fragment array specifically for link and tag counting
 * This provides optimized handling for the specific use case in router.ts
 */
export function countFragmentMatches(
  fragments: Fragment[] | unknown,
  pattern: RegExp,
  context?: string
): number {
  try {
    if (!Array.isArray(fragments)) {
      // Fall back to string conversion if not an array
      return safeCountMatches(fragments, pattern, context);
    }
    
    let totalCount = 0;
    
    fragments.forEach(fragment => {
      // Handle different possible fragment structures
      const fragmentText = typeof fragment === 'string' ? fragment : 
                          (fragment?.content || fragment?.text || fragment?.data || '');
      
      if (typeof fragmentText === 'string' && fragmentText.length > 0) {
        const matches = fragmentText.match(pattern);
        totalCount += matches ? matches.length : 0;
      }
    });
    
    return totalCount;
    
  } catch (error) {
    console.warn(`Fragment match counting failed${context ? ` in ${context}` : ''}:`, {
      fragmentsLength: Array.isArray(fragments) ? fragments.length : 'not array',
      pattern: pattern.toString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return 0;
  }
}