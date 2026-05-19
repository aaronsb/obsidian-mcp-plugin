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
 * Calculate Levenshtein distance between two strings.
 *
 * Two-row formulation: only the previous and current rows are kept instead
 * of the full (m+1)x(n+1) matrix. This bounds memory at O(n) and avoids the
 * per-call array-of-arrays allocation that, run per line across a large
 * file, was a meaningful contributor to the main-thread stalls in #125.
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
    
    // Length heuristic: a line far shorter than the search text cannot
    // clear the threshold — skip the expensive phrase scan entirely.
    if (normalizedLine.length < normalizedSearch.length * threshold * 0.8) {
      continue;
    }

    // Try matching key phrases
    let bestSimilarity = 0;
    let bestStart = 0;
    let bestEnd = line.length;

    // Sliding window approach for phrase matching
    const words = line.split(/\s+/).filter(w => w.length > 0);
    for (let start = 0; start < words.length; start++) {
      // Cap the window near the query length to avoid O(N^2) blowup on
      // long lines.
      const maxEnd = Math.min(words.length, start + searchWords.length + 3);
      for (let end = start + 1; end <= maxEnd; end++) {
        const phrase = words.slice(start, end).join(' ');

        // Skip the distance calc when lengths are too far apart to clear
        // the threshold anyway.
        if (Math.abs(phrase.length - normalizedSearch.length) > normalizedSearch.length * (1 - threshold) + 2) {
          continue;
        }

        const similarity = calculateSimilarity(phrase, normalizedSearch);

        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestStart = line.indexOf(words[start]);
          bestEnd = line.indexOf(words[end - 1]) + words[end - 1].length;

          // A near-perfect phrase match won't be beaten — stop scanning
          // this line.
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