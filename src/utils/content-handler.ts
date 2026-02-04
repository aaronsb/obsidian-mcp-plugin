import { Debug } from './debug';

/**
 * Represents a content fragment that may have text in various properties
 */
interface ContentFragment {
  content?: unknown;
  text?: unknown;
  data?: unknown;
}

/**
 * Type guard to check if a value is a ContentFragment (an object with content/text/data properties)
 */
function isContentFragment(value: unknown): value is ContentFragment {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract text from a potential fragment object
 */
function extractFragmentText(item: unknown): string {
  if (typeof item === 'string') {
    return item;
  }
  if (isContentFragment(item)) {
    const raw = item.content ?? item.text ?? item.data ?? '';
    return typeof raw === 'string' ? raw : '';
  }
  return '';
}

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
        .map(item => extractFragmentText(item))
        .filter(text => text.length > 0)
        .join('\n');
    }
    
    // Handle objects with custom toString method
    if (typeof content === 'object' && content !== null) {
      // Check if object has a custom toString (not the default Object.prototype.toString)
      if (content.toString !== Object.prototype.toString) {
        // Object has custom toString - safe to call
        return (content as { toString(): string }).toString();
      }
      // For plain objects, use JSON serialization
      return JSON.stringify(content);
    }

    // Fallback: convert primitives (number, boolean, bigint, symbol) to string
    return String(content as string | number | boolean | bigint | symbol);
    
  } catch (error) {
    Debug.warn(`Content conversion failed${context ? ` in ${context}` : ''}:`, {
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
    Debug.warn(`Match operation failed${context ? ` in ${context}` : ''}:`, {
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
  fragments: unknown,
  pattern: RegExp,
  context?: string
): number {
  try {
    if (!Array.isArray(fragments)) {
      // Fall back to string conversion if not an array
      return safeCountMatches(fragments, pattern, context);
    }
    
    let totalCount = 0;
    
    fragments.forEach((fragment: unknown) => {
      // Handle different possible fragment structures
      const fragmentText = extractFragmentText(fragment);

      if (fragmentText.length > 0) {
        const matches = fragmentText.match(pattern);
        totalCount += matches ? matches.length : 0;
      }
    });
    
    return totalCount;
    
  } catch (error) {
    Debug.warn(`Fragment match counting failed${context ? ` in ${context}` : ''}:`, {
      fragmentsLength: Array.isArray(fragments) ? fragments.length : 'not array',
      pattern: pattern.toString(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return 0;
  }
}