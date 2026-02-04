import { App, TFile, CachedMetadata, getAllTags } from 'obsidian';
import { Debug } from './debug';
import { AdvancedSearchService, SearchResult as AdvancedSearchResult } from './advanced-search';

/**
 * Unified search result format returned by SearchFacade
 */
export interface UnifiedSearchResult {
  path: string;
  title: string;
  score: number;
  snippet?: {
    content: string;
    lineStart: number;
    lineEnd: number;
    score: number;
  };
  matches?: {
    filename?: boolean;
    content?: boolean;
    tags?: string[];
  };
  metadata?: {
    size: number;
    modified: number;
    extension: string;
  };
}

/**
 * Options for search facade
 */
export interface SearchFacadeOptions {
  /** Use TF-IDF scoring for relevance ranking (default: auto based on query type) */
  ranked?: boolean;

  /** Include contextual snippets in results (default: true) */
  includeSnippets?: boolean;

  /** Maximum snippet length in characters (default: 300) */
  snippetLength?: number;

  /** Search strategy: 'filename', 'content', 'combined', 'auto' (default: 'auto') */
  strategy?: 'filename' | 'content' | 'combined' | 'auto';

  /** Maximum number of results (default: 50) */
  maxResults?: number;

  /** Include file metadata in results (default: true) */
  includeMetadata?: boolean;

  /** Page number for pagination (1-indexed, default: 1) */
  page?: number;

  /** Number of results per page (default: 10) */
  pageSize?: number;
}

/**
 * Paginated search response
 */
export interface PaginatedSearchResponse {
  query: string;
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  results: UnifiedSearchResult[];
  method: string;
  truncated?: boolean;
  originalCount?: number;
  message?: string;
}

/**
 * Parsed query structure
 */
interface ParsedQuery {
  type: 'operator' | 'natural';
  operator?: 'file' | 'path' | 'content' | 'tag';
  term: string;
  originalQuery: string;
  isRegex?: boolean;
  regex?: RegExp;
  isOr?: boolean;
  orTerms?: string[];
  isAnd?: boolean;
  andTerms?: string[];
}

/**
 * SearchFacade - Unified search interface composing multiple search strategies
 *
 * Routes queries intelligently:
 * - Operator queries (file:, tag:, etc.) → fast operator-based search
 * - Natural language queries → AdvancedSearchService with TF-IDF ranking
 */
export class SearchFacade {
  private app: App;
  private advancedSearch: AdvancedSearchService;

  constructor(app: App) {
    this.app = app;
    this.advancedSearch = new AdvancedSearchService(app);
  }

  /**
   * Perform search with unified interface
   */
  async search(query: string, options: SearchFacadeOptions = {}): Promise<UnifiedSearchResult[]> {
    const {
      ranked,
      includeSnippets = true,
      snippetLength = 300,
      strategy = 'auto',
      maxResults = 50,
      includeMetadata = true
    } = options;

    if (!query || query.trim().length === 0) {
      return [];
    }

    const parsed = this.parseQuery(query);
    Debug.log('SearchFacade: Parsed query', { parsed, options });

    let results: UnifiedSearchResult[];

    if (parsed.type === 'operator') {
      // Use operator-based search for precise queries
      results = await this.operatorSearch(parsed, {
        includeSnippets,
        snippetLength,
        includeMetadata
      });

      // Apply ranking as post-process if explicitly requested
      if (ranked === true) {
        results = this.applyRanking(results, parsed.term);
      }
    } else {
      // Use advanced search for natural language queries
      const advancedStrategy = strategy === 'auto' ? 'combined' : strategy;
      const advancedResults = await this.advancedSearch.search(query, {
        strategy: advancedStrategy,
        maxResults,
        snippetLength,
        includeMetadata
      });

      results = this.normalizeAdvancedResults(advancedResults);
    }

    // Sort by score and limit
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Perform search with pagination - primary method for MCP tool use
   */
  async searchPaginated(query: string, options: SearchFacadeOptions = {}): Promise<PaginatedSearchResponse> {
    const {
      page = 1,
      pageSize = 10,
      strategy = 'auto'
    } = options;

    if (!query || query.trim().length === 0) {
      return {
        query: query || '',
        page: 1,
        pageSize,
        totalResults: 0,
        totalPages: 0,
        results: [],
        method: 'facade'
      };
    }

    // Get all results (facade limits internally via maxResults)
    const allResults = await this.search(query, {
      ...options,
      maxResults: options.maxResults || 100  // Get more results for pagination
    });

    // Apply pagination
    const totalResults = allResults.length;
    const totalPages = Math.ceil(totalResults / pageSize);
    const startIdx = (page - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const paginatedResults = allResults.slice(startIdx, endIdx);

    // Determine method based on query type
    const parsed = this.parseQuery(query);
    const method = parsed.type === 'operator' ? `facade-operator-${strategy}` : `facade-ranked-${strategy}`;

    return {
      query,
      page,
      pageSize,
      totalResults,
      totalPages,
      results: paginatedResults,
      method
    };
  }

  /**
   * Parse query to determine routing strategy
   */
  private parseQuery(query: string): ParsedQuery {
    const trimmed = query.trim();

    // Check for regex pattern /pattern/flags
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
      const lastSlash = trimmed.lastIndexOf('/');
      const pattern = trimmed.substring(1, lastSlash);
      const flags = trimmed.substring(lastSlash + 1);
      try {
        const regex = new RegExp(pattern, flags);
        return {
          type: 'operator',
          term: pattern,
          originalQuery: query,
          isRegex: true,
          regex
        };
      } catch (e) {
        Debug.warn('Invalid regex pattern:', e);
      }
    }

    // Check for operators
    if (trimmed.startsWith('file:')) {
      return { type: 'operator', operator: 'file', term: trimmed.substring(5).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('path:')) {
      return { type: 'operator', operator: 'path', term: trimmed.substring(5).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('content:')) {
      return { type: 'operator', operator: 'content', term: trimmed.substring(8).trim(), originalQuery: query };
    }
    if (trimmed.startsWith('tag:')) {
      return { type: 'operator', operator: 'tag', term: trimmed.substring(4).trim(), originalQuery: query };
    }

    // Check for AND operator
    if (trimmed.includes(' AND ')) {
      const andTerms = this.splitPreservingQuotes(trimmed, ' AND ');
      return {
        type: 'operator',
        term: trimmed,
        originalQuery: query,
        isAnd: true,
        andTerms
      };
    }

    // Check for OR operator
    if (trimmed.includes(' OR ')) {
      const orTerms = this.splitPreservingQuotes(trimmed, ' OR ');
      return {
        type: 'operator',
        term: trimmed,
        originalQuery: query,
        isOr: true,
        orTerms
      };
    }

    // Natural language query - route to advanced search
    return { type: 'natural', term: trimmed, originalQuery: query };
  }

  /**
   * Split query on delimiter while preserving quoted phrases
   */
  private splitPreservingQuotes(query: string, delimiter: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < query.length) {
      if (query[i] === '"') {
        inQuotes = !inQuotes;
        current += query[i];
        i++;
      } else if (!inQuotes && query.substring(i, i + delimiter.length) === delimiter) {
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = '';
        i += delimiter.length;
      } else {
        current += query[i];
        i++;
      }
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  /**
   * Operator-based search (file:, tag:, path:, content:, regex, OR, AND)
   */
  private async operatorSearch(
    parsed: ParsedQuery,
    options: { includeSnippets: boolean; snippetLength: number; includeMetadata: boolean }
  ): Promise<UnifiedSearchResult[]> {
    const files = this.app.vault.getFiles();
    const results: UnifiedSearchResult[] = [];

    for (const file of files) {
      const result = await this.matchFile(file, parsed, options);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Match a file against parsed query
   */
  private async matchFile(
    file: TFile,
    parsed: ParsedQuery,
    options: { includeSnippets: boolean; snippetLength: number; includeMetadata: boolean }
  ): Promise<UnifiedSearchResult | null> {
    const termLower = parsed.term.toLowerCase();
    let score = 0;
    let snippet: UnifiedSearchResult['snippet'] | undefined;
    const matches: UnifiedSearchResult['matches'] = {};

    // Helper for text matching
    const textMatches = (text: string): boolean => {
      if (parsed.isRegex && parsed.regex) {
        return parsed.regex.test(text);
      }
      return text.toLowerCase().includes(termLower);
    };

    // Handle AND queries
    if (parsed.isAnd && parsed.andTerms) {
      const allMatch = await this.checkAndMatch(file, parsed.andTerms, options);
      if (allMatch.matches) {
        return {
          path: file.path,
          title: file.basename,
          score: allMatch.score,
          snippet: allMatch.snippet,
          matches: allMatch.matchDetails,
          metadata: options.includeMetadata ? this.getMetadata(file) : undefined
        };
      }
      return null;
    }

    // Handle OR queries
    if (parsed.isOr && parsed.orTerms) {
      const anyMatch = await this.checkOrMatch(file, parsed.orTerms, options);
      if (anyMatch.matches) {
        return {
          path: file.path,
          title: file.basename,
          score: anyMatch.score,
          snippet: anyMatch.snippet,
          matches: anyMatch.matchDetails,
          metadata: options.includeMetadata ? this.getMetadata(file) : undefined
        };
      }
      return null;
    }

    // Handle specific operators
    switch (parsed.operator) {
      case 'file':
        if (textMatches(file.basename) || textMatches(file.name)) {
          score = 1.0;
          matches.filename = true;
        }
        break;

      case 'path':
        if (textMatches(file.path)) {
          score = 1.0;
          matches.filename = true;
        }
        break;

      case 'tag': {
        const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
        if (cache) {
          const tags: string[] = getAllTags(cache) || [];
          const target = termLower.startsWith('#') ? termLower : `#${termLower}`;
          const matchedTags: string[] = tags.filter((t: string) => {
            const tl = String(t).toLowerCase();
            return tl === target || tl.startsWith(`${target}/`);
          });
          if (matchedTags.length > 0) {
            score = 1.0;
            matches.tags = matchedTags;
          }
        }
        break;
      }

      case 'content':
        if (this.isTextFile(file)) {
          try {
            const content = await this.app.vault.read(file);
            if (textMatches(content)) {
              score = 1.0;
              matches.content = true;
              if (options.includeSnippets) {
                snippet = this.extractSnippet(content, parsed.term, options.snippetLength);
              }
            }
          } catch (e) {
            Debug.warn(`Error reading file ${file.path}:`, e);
          }
        }
        break;

      default:
        // General search (regex or plain text) - check filename and content
        if (textMatches(file.basename) || textMatches(file.name)) {
          score = 1.5;
          matches.filename = true;
        }

        if (this.isTextFile(file)) {
          try {
            const content = await this.app.vault.read(file);
            if (textMatches(content)) {
              score = Math.max(score, 1.0);
              matches.content = true;
              if (options.includeSnippets) {
                snippet = this.extractSnippet(content, parsed.term, options.snippetLength);
              }
            }
          } catch (e) {
            Debug.warn(`Error reading file ${file.path}:`, e);
          }
        }
        break;
    }

    if (score === 0) {
      return null;
    }

    return {
      path: file.path,
      title: file.basename,
      score,
      snippet,
      matches,
      metadata: options.includeMetadata ? this.getMetadata(file) : undefined
    };
  }

  /**
   * Check if ALL terms match (AND logic)
   */
  private async checkAndMatch(
    file: TFile,
    terms: string[],
    options: { includeSnippets: boolean; snippetLength: number }
  ): Promise<{ matches: boolean; score: number; snippet?: UnifiedSearchResult['snippet']; matchDetails: UnifiedSearchResult['matches'] }> {
    let content: string | null = null;
    let matchCount = 0;
    let snippet: UnifiedSearchResult['snippet'] | undefined;
    const matchDetails: UnifiedSearchResult['matches'] = {};

    for (const term of terms) {
      const termLower = term.toLowerCase().replace(/^"|"$/g, ''); // Remove quotes
      let termMatches = false;

      // Check filename
      if (file.basename.toLowerCase().includes(termLower)) {
        termMatches = true;
        matchDetails.filename = true;
      }

      // Check content
      if (!termMatches && this.isTextFile(file)) {
        if (content === null) {
          try {
            content = await this.app.vault.read(file);
          } catch {
            content = '';
          }
        }
        if (content.toLowerCase().includes(termLower)) {
          termMatches = true;
          matchDetails.content = true;
          if (options.includeSnippets && !snippet) {
            snippet = this.extractSnippet(content, term, options.snippetLength);
          }
        }
      }

      if (termMatches) {
        matchCount++;
      } else {
        // AND requires ALL terms to match
        return { matches: false, score: 0, matchDetails: {} };
      }
    }

    // All terms matched - score based on match count
    const score = matchCount / terms.length;
    return { matches: true, score, snippet, matchDetails };
  }

  /**
   * Check if ANY term matches (OR logic) with scoring for multiple matches
   */
  private async checkOrMatch(
    file: TFile,
    terms: string[],
    options: { includeSnippets: boolean; snippetLength: number }
  ): Promise<{ matches: boolean; score: number; snippet?: UnifiedSearchResult['snippet']; matchDetails: UnifiedSearchResult['matches'] }> {
    let content: string | null = null;
    let matchCount = 0;
    let snippet: UnifiedSearchResult['snippet'] | undefined;
    const matchDetails: UnifiedSearchResult['matches'] = {};

    for (const term of terms) {
      const termLower = term.toLowerCase().replace(/^"|"$/g, '');
      let termMatches = false;

      // Check filename
      if (file.basename.toLowerCase().includes(termLower)) {
        termMatches = true;
        matchDetails.filename = true;
      }

      // Check content
      if (this.isTextFile(file)) {
        if (content === null) {
          try {
            content = await this.app.vault.read(file);
          } catch {
            content = '';
          }
        }
        if (content.toLowerCase().includes(termLower)) {
          termMatches = true;
          matchDetails.content = true;
          if (options.includeSnippets && !snippet) {
            snippet = this.extractSnippet(content, term, options.snippetLength);
          }
        }
      }

      if (termMatches) {
        matchCount++;
      }
    }

    if (matchCount === 0) {
      return { matches: false, score: 0, matchDetails: {} };
    }

    // Score based on how many OR terms matched (more = better)
    const score = matchCount / terms.length;
    return { matches: true, score, snippet, matchDetails };
  }

  /**
   * Extract a snippet around the search term
   */
  private extractSnippet(
    content: string,
    searchTerm: string,
    maxLength: number
  ): UnifiedSearchResult['snippet'] | undefined {
    const termLower = searchTerm.toLowerCase().replace(/^"|"$/g, '');
    const contentLower = content.toLowerCase();
    const index = contentLower.indexOf(termLower);

    if (index === -1) {
      return undefined;
    }

    const lines = content.split('\n');
    let charCount = 0;
    let startLine = 0;

    // Find the line containing the match
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= index) {
        startLine = i;
        break;
      }
      charCount += lines[i].length + 1; // +1 for newline
    }

    // Extract snippet around the match
    let snippetText = '';
    let endLine = startLine;

    for (let i = startLine; i < lines.length && snippetText.length < maxLength; i++) {
      snippetText += (i > startLine ? '\n' : '') + lines[i];
      endLine = i;
    }

    if (snippetText.length > maxLength) {
      snippetText = snippetText.substring(0, maxLength) + '...';
    }

    return {
      content: snippetText,
      lineStart: startLine + 1,
      lineEnd: endLine + 1,
      score: 1.0 // Default snippet relevance score
    };
  }

  /**
   * Apply TF-IDF-like ranking to results
   */
  private applyRanking(results: UnifiedSearchResult[], searchTerm: string): UnifiedSearchResult[] {
    // Simple term frequency boost - more sophisticated ranking already in AdvancedSearchService
    const termLower = searchTerm.toLowerCase();

    return results.map(result => {
      let boost = 1.0;

      // Boost exact filename matches
      if (result.title.toLowerCase() === termLower) {
        boost = 2.0;
      } else if (result.title.toLowerCase().includes(termLower)) {
        boost = 1.5;
      }

      return {
        ...result,
        score: result.score * boost
      };
    });
  }

  /**
   * Normalize results from AdvancedSearchService
   */
  private normalizeAdvancedResults(results: AdvancedSearchResult[]): UnifiedSearchResult[] {
    return results.map(r => ({
      path: r.path,
      title: r.title,
      score: r.score,
      snippet: r.snippet ? {
        content: r.snippet.content,
        lineStart: r.snippet.lineStart,
        lineEnd: r.snippet.lineEnd,
        score: r.snippet.score
      } : undefined,
      matches: {
        content: true // Advanced search always searches content
      },
      metadata: r.metadata
    }));
  }

  /**
   * Get file metadata
   */
  private getMetadata(file: TFile): UnifiedSearchResult['metadata'] {
    return {
      size: file.stat.size,
      modified: file.stat.mtime,
      extension: file.extension
    };
  }

  /**
   * Check if file is a text file
   */
  private isTextFile(file: TFile): boolean {
    const textExtensions = new Set([
      'md', 'txt', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml',
      'csv', 'log', 'py', 'java', 'cpp', 'c', 'h', 'php', 'rb', 'go', 'rs',
      'sql', 'sh', 'bat', 'ps1', 'ini', 'conf', 'config', 'env'
    ]);
    return textExtensions.has(file.extension.toLowerCase());
  }
}
