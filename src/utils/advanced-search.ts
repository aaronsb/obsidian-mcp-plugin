import { Debug } from './debug';
import { TFile, App } from 'obsidian';
import { estimateTokens, truncateContent } from './response-limiter';

export interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet?: {
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
  };
  metadata?: {
    size: number;
    modified: number;
    extension: string;
  };
}

export interface SearchOptions {
  strategy?: 'filename' | 'content' | 'combined';
  maxResults?: number;
  snippetLength?: number;
  includeMetadata?: boolean;
}

export class AdvancedSearchService {
  private app: App;
  
  constructor(app: App) {
    this.app = app;
  }

  /**
   * Check if a file is readable as text (not binary)
   */
  private isTextFile(file: TFile): boolean {
    const textExtensions = new Set([
      'md', 'txt', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml', 
      'csv', 'log', 'py', 'java', 'cpp', 'c', 'h', 'php', 'rb', 'go', 'rs',
      'sql', 'sh', 'bat', 'ps1', 'ini', 'conf', 'config', 'env'
    ]);
    return textExtensions.has(file.extension.toLowerCase());
  }

  /**
   * Perform advanced search with ranking and snippets
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      strategy = 'combined',
      maxResults = 50,
      snippetLength = 300,
      includeMetadata = true
    } = options;

    if (!query || query.trim().length === 0) {
      return [];
    }

    const normalizedQuery = this.normalizeQuery(query);
    const queryTokens = this.tokenize(normalizedQuery);
    
    // Get all files in the vault
    const files = this.app.vault.getFiles();
    const results: SearchResult[] = [];
    
    for (const file of files) {
      let result: SearchResult | null = null;
      
      switch (strategy) {
        case 'filename':
          result = await this.searchFilename(file, queryTokens, includeMetadata);
          break;
        case 'content':
          result = await this.searchContent(file, queryTokens, snippetLength, includeMetadata);
          break;
        case 'combined':
          result = await this.searchCombined(file, queryTokens, snippetLength, includeMetadata);
          break;
      }
      
      if (result && result.score > 0) {
        results.push(result);
      }
    }
    
    // Sort by score and limit results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Search based on filename only
   */
  private async searchFilename(
    file: TFile, 
    queryTokens: string[], 
    includeMetadata: boolean
  ): Promise<SearchResult | null> {
    const filename = file.basename.toLowerCase();
    const filenameTokens = this.tokenize(filename);
    
    const score = this.calculateTokenScore(filenameTokens, queryTokens);
    
    if (score === 0) {
      return null;
    }
    
    const result: SearchResult = {
      path: file.path,
      title: file.basename,
      score: score * 2 // Boost filename matches
    };
    
    if (includeMetadata) {
      result.metadata = {
        size: file.stat.size,
        modified: file.stat.mtime,
        extension: file.extension
      };
    }
    
    return result;
  }

  /**
   * Search based on file content with snippet extraction
   */
  private async searchContent(
    file: TFile, 
    queryTokens: string[], 
    snippetLength: number,
    includeMetadata: boolean
  ): Promise<SearchResult | null> {
    // Only attempt content search for text files
    if (!this.isTextFile(file)) {
      return null;
    }

    try {
      const content = await this.app.vault.read(file);
      const contentTokens = this.tokenize(content.toLowerCase());
      
      const score = this.calculateTokenScore(contentTokens, queryTokens);
      
      if (score === 0) {
        return null;
      }
      
      const snippet = this.extractBestSnippet(content, queryTokens, snippetLength);
      
      const result: SearchResult = {
        path: file.path,
        title: file.basename,
        score,
        snippet
      };
      
      if (includeMetadata) {
        result.metadata = {
          size: file.stat.size,
          modified: file.stat.mtime,
          extension: file.extension
        };
      }
      
      return result;
    } catch (error) {
      Debug.warn(`Error reading file ${file.path}:`, error);
      return null;
    }
  }

  /**
   * Combined search strategy (filename + content)
   */
  private async searchCombined(
    file: TFile, 
    queryTokens: string[], 
    snippetLength: number,
    includeMetadata: boolean
  ): Promise<SearchResult | null> {
    const filenameResult = await this.searchFilename(file, queryTokens, false);
    const contentResult = await this.searchContent(file, queryTokens, snippetLength, false);
    
    const filenameScore = filenameResult?.score || 0;
    const contentScore = contentResult?.score || 0;
    
    if (filenameScore === 0 && contentScore === 0) {
      return null;
    }
    
    // Combine scores with filename boost
    const combinedScore = filenameScore * 1.5 + contentScore;
    
    const result: SearchResult = {
      path: file.path,
      title: file.basename,
      score: combinedScore
    };
    
    // Include snippet from content search if available
    if (contentResult?.snippet) {
      result.snippet = contentResult.snippet;
    }
    
    if (includeMetadata) {
      result.metadata = {
        size: file.stat.size,
        modified: file.stat.mtime,
        extension: file.extension
      };
    }
    
    return result;
  }

  /**
   * Extract the best snippet around query matches
   */
  private extractBestSnippet(
    content: string, 
    queryTokens: string[], 
    maxLength: number
  ): { content: string; lineStart: number; lineEnd: number; score: number } | undefined {
    const lines = content.split('\n');
    const windows: Array<{ text: string; start: number; end: number; score: number }> = [];
    
    // Create overlapping windows of sentences/lines
    for (let i = 0; i < lines.length; i++) {
      let window = lines[i];
      const windowStart = i;
      let j = i + 1;
      
      // Extend window until we reach max length or end of file
      while (j < lines.length && window.length < maxLength) {
        window += '\n' + lines[j];
        j++;
      }
      
      const windowTokens = this.tokenize(window.toLowerCase());
      const score = this.calculateTokenScore(windowTokens, queryTokens);
      
      if (score > 0) {
        windows.push({
          text: window,
          start: windowStart,
          end: j - 1,
          score
        });
      }
    }
    
    if (windows.length === 0) {
      // Fallback: return first chunk of content
      const truncatedContent = truncateContent(content, maxLength);
      return {
        content: truncatedContent,
        lineStart: 1,
        lineEnd: Math.min(10, lines.length),
        score: 0.1
      };
    }
    
    // Return the highest scoring window
    const bestWindow = windows.sort((a, b) => b.score - a.score)[0];
    
    return {
      content: truncateContent(bestWindow.text, maxLength),
      lineStart: bestWindow.start + 1, // 1-indexed
      lineEnd: bestWindow.end + 1,
      score: bestWindow.score
    };
  }

  /**
   * Calculate token-based score using TF-IDF-like approach
   */
  private calculateTokenScore(tokens: string[], queryTokens: string[]): number {
    if (queryTokens.length === 0) return 0;
    
    let score = 0;
    const tokenFreq = new Map<string, number>();
    
    // Count token frequencies
    for (const token of tokens) {
      tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
    }
    
    // Score based on query token matches
    for (const queryToken of queryTokens) {
      const frequency = tokenFreq.get(queryToken) || 0;
      if (frequency > 0) {
        // TF-IDF inspired scoring: frequency with diminishing returns
        score += Math.log(1 + frequency);
      }
    }
    
    // Normalize by query length and document length
    return score / (queryTokens.length * Math.log(tokens.length + 1));
  }

  /**
   * Tokenize text into searchable terms
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .split(/\s+/)
      .filter(token => token.length > 2) // Filter out very short tokens
      .filter(token => !this.isStopWord(token));
  }

  /**
   * Normalize query for better matching
   */
  private normalizeQuery(query: string): string {
    return query
      .trim()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .replace(/\s+/g, ' '); // Normalize whitespace
  }

  /**
   * Check if a word is a stop word
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 
      'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 
      'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 
      'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they'
    ]);
    return stopWords.has(word.toLowerCase());
  }
}