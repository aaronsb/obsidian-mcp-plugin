/**
 * Fuzzy matching utilities for finding approximate string matches
 */

export interface FuzzyMatch {
  line: string;
  lineNumber: number;
  similarity: number;
  startIndex: number;
  endIndex: number;
}

/**
 * Calculate similarity between two strings using Levenshtein distance
 * Optimized to use only two rows instead of a full matrix to reduce memory allocations
 */
function levenshteinDistance(str1: string, str2: string): number {
  if (str1 === str2) return 0;
  if (str1.length === 0) return str2.length;
  if (str2.length === 0) return str1.length;

  let prevRow = new Int32Array(str2.length + 1);
  let currRow = new Int32Array(str2.length + 1);

  for (let i = 0; i <= str2.length; i++) {
    prevRow[i] = i;
  }

  for (let i = 1; i <= str1.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= str2.length; j++) {
      if (str1.charAt(i - 1) === str2.charAt(j - 1)) {
        currRow[j] = prevRow[j - 1];
      } else {
        currRow[j] = Math.min(
          prevRow[j - 1] + 1, // substitution
          currRow[j - 1] + 1, // insertion
          prevRow[j] + 1      // deletion
        );
      }
    }
    // Swap rows
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[str2.length];
}

/**
 * Calculate similarity ratio between two strings (0-1)
 */
export function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  
  // Quick length-based heuristic: if lengths are very different, similarity can't be high
  // This helps skip expensive Levenshtein calc in some cases if called from elsewhere
  
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  return 1 - (distance / maxLength);
}

/**
 * Find fuzzy matches in content
 */
export function findFuzzyMatches(
  content: string,
  searchText: string,
  threshold: number = 0.7,
  maxMatches: number = 5
): FuzzyMatch[] {
  const lines = content.split('\n');
  const matches: FuzzyMatch[] = [];
  
  // Normalize search text
  const normalizedSearch = searchText.toLowerCase().trim();
  if (!normalizedSearch) return [];
  
  const searchWords = normalizedSearch.split(/\s+/).filter(w => w.length > 0);
  if (searchWords.length === 0) return [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const normalizedLine = line.toLowerCase();
    
    // Try exact substring match first (most efficient)
    if (normalizedLine.includes(normalizedSearch)) {
      const startIndex = normalizedLine.indexOf(normalizedSearch);
      matches.push({
        line,
        lineNumber: i + 1,
        similarity: 1.0,
        startIndex,
        endIndex: startIndex + searchText.length
      });
      continue;
    }
    
    // Quick heuristic: skip lines that are too short to possibly contain the search text with given threshold
    // If threshold is 0.7, line length must be at least 70% of search text length (roughly)
    if (normalizedLine.length < normalizedSearch.length * threshold * 0.8) {
        continue;
    }

    // Try matching key phrases
    let bestSimilarity = 0;
    let bestStart = 0;
    let bestEnd = line.length;
    
    // Sliding window approach for phrase matching
    const words = line.split(/\s+/).filter(w => w.length > 0);
    // If fewer words than search query, we can still match but it's less likely
    
    for (let start = 0; start < words.length; start++) {
      // Limit end to searchWords.length + 2 to avoid O(N^2) explosion on long lines
      const maxEnd = Math.min(words.length, start + searchWords.length + 3);
      for (let end = start + 1; end <= maxEnd; end++) {
        const phrase = words.slice(start, end).join(' ');
        
        // Skip similarity calc if lengths are extremely different
        if (Math.abs(phrase.length - normalizedSearch.length) > normalizedSearch.length * (1 - threshold) + 2) {
            continue;
        }

        const similarity = calculateSimilarity(phrase, normalizedSearch);
        
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestStart = line.indexOf(words[start]);
          bestEnd = line.indexOf(words[end - 1]) + words[end - 1].length;
          
          // Optimization: if we found a very high match, stop looking in this line
          if (bestSimilarity >= 0.95) break;
        }
      }
      if (bestSimilarity >= 0.95) break;
    }
    
    if (bestSimilarity >= threshold) {
      matches.push({
        line,
        lineNumber: i + 1,
        similarity: bestSimilarity,
        startIndex: bestStart,
        endIndex: bestEnd
      });
    }
  }
  
  // Sort by similarity and return top matches
  return matches
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxMatches);
}

/**
 * Extract context around a line number
 */
export function extractContext(
  content: string,
  lineNumber: number,
  contextLines: number = 3
): { lines: string[]; startLine: number; endLine: number } {
  const allLines = content.split('\n');
  const startLine = Math.max(1, lineNumber - contextLines);
  const endLine = Math.min(allLines.length, lineNumber + contextLines);
  
  return {
    lines: allLines.slice(startLine - 1, endLine),
    startLine,
    endLine
  };
}