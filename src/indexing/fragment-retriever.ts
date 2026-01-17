import { AdaptiveTextIndex } from './adaptive-index';
import { ProximityFragmentIndex } from './proximity-index';
import { SemanticChunkIndex } from './semantic-chunk-index';
import { Fragment, RetrievalOptions } from '../types/fragment';
import { SemanticResponse } from '../types/semantic';

/**
 * Unified fragment retrieval system that automatically selects the best strategy
 * Integrates with the MCP semantic flow and hinting system
 */
export class UniversalFragmentRetriever {
  private adaptiveIndex = new AdaptiveTextIndex();
  private proximityIndex = new ProximityFragmentIndex();
  private semanticIndex = new SemanticChunkIndex();
  private indexedDocs = new Set<string>();
  
  /**
   * Index a document for fragment retrieval
   */
  async indexDocument(docId: string, filePath: string, content: string, metadata?: unknown): Promise<void> {
    // Index in all three strategies for flexibility
    this.adaptiveIndex.indexDocument(docId, filePath, content, metadata);
    this.proximityIndex.indexDocument(docId, filePath, content);
    this.semanticIndex.indexDocument(docId, filePath, content);
    this.indexedDocs.add(docId);
  }
  
  /**
   * Retrieve fragments based on query with semantic hints
   */
  async retrieveFragments(
    query: string,
    options: RetrievalOptions = {}
  ): Promise<SemanticResponse<Fragment[]>> {
    const { strategy = 'auto', maxFragments = 5 } = options;
    
    let fragments: Fragment[] = [];
    let selectedStrategy: string = strategy;
    
    if (strategy === 'auto') {
      // Choose strategy based on query characteristics
      selectedStrategy = this.selectOptimalStrategy(query);
    }
    
    // Execute the selected strategy (all search methods are synchronous)
    switch (selectedStrategy) {
      case 'adaptive':
        fragments = this.adaptiveIndex.search(query, maxFragments);
        break;

      case 'proximity':
        fragments = this.proximityIndex.searchWithProximity(query);
        break;

      case 'semantic':
        fragments = this.semanticIndex.searchWithContext(query, { maxFragments });
        break;

      default:
        // Hybrid approach - combine results from multiple strategies
        fragments = this.hybridSearch(query, maxFragments);
        selectedStrategy = 'hybrid';
    }
    
    // Limit to requested number of fragments
    fragments = fragments.slice(0, maxFragments);
    
    // Build semantic response with hints - pass original strategy for efficiency hints
    return this.buildSemanticResponse(fragments, query, selectedStrategy, strategy);
  }
  
  /**
   * Clear all indexes
   */
  clearIndexes(): void {
    this.adaptiveIndex = new AdaptiveTextIndex();
    this.proximityIndex = new ProximityFragmentIndex();
    this.semanticIndex = new SemanticChunkIndex();
    this.indexedDocs.clear();
  }
  
  /**
   * Get indexed document count
   */
  getIndexedDocumentCount(): number {
    return this.indexedDocs.size;
  }
  
  private selectOptimalStrategy(query: string): string {
    // Handle undefined or empty query
    if (!query || query.trim().length === 0) {
      return 'adaptive'; // Default to adaptive for empty queries
    }
    
    const queryWords = query.split(/\s+/).filter(w => w.length > 0);
    const queryLength = queryWords.length;
    
    if (queryLength <= 2) {
      // Short queries benefit from adaptive scoring
      return 'adaptive';
    } else if (queryLength <= 5) {
      // Medium queries benefit from proximity search
      return 'proximity';
    } else {
      // Long queries benefit from semantic chunking
      return 'semantic';
    }
  }
  
  private hybridSearch(query: string, maxFragments: number): Fragment[] {
    // Get results from all strategies (all search methods are synchronous)
    const adaptiveResults = this.adaptiveIndex.search(query, maxFragments * 2);
    const proximityResults = this.proximityIndex.searchWithProximity(query);
    const semanticResults = this.semanticIndex.searchWithContext(query, { maxFragments: maxFragments * 2 });
    
    // Merge and deduplicate results
    const fragmentMap = new Map<string, Fragment>();
    
    // Weight different strategies
    const weights = {
      adaptive: 0.4,
      proximity: 0.3,
      semantic: 0.3
    };
    
    // Process adaptive results
    adaptiveResults.forEach(fragment => {
      const key = `${fragment.docPath}:${fragment.lineStart}`;
      fragmentMap.set(key, {
        ...fragment,
        score: fragment.score * weights.adaptive
      });
    });
    
    // Merge proximity results
    proximityResults.forEach(fragment => {
      const key = `${fragment.docPath}:${fragment.lineStart}`;
      if (fragmentMap.has(key)) {
        const existing = fragmentMap.get(key)!;
        existing.score += fragment.score * weights.proximity;
      } else {
        fragmentMap.set(key, {
          ...fragment,
          score: fragment.score * weights.proximity
        });
      }
    });
    
    // Merge semantic results
    semanticResults.forEach(fragment => {
      const key = `${fragment.docPath}:${fragment.lineStart}`;
      if (fragmentMap.has(key)) {
        const existing = fragmentMap.get(key)!;
        existing.score += fragment.score * weights.semantic;
      } else {
        fragmentMap.set(key, {
          ...fragment,
          score: fragment.score * weights.semantic
        });
      }
    });
    
    // Sort by combined score and return top results
    return Array.from(fragmentMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFragments);
  }
  
  private buildSemanticResponse(
    fragments: Fragment[], 
    query: string, 
    strategy: string,
    originalStrategy?: string
  ): SemanticResponse<Fragment[]> {
    const response: SemanticResponse<Fragment[]> = {
      result: fragments
    };
    
    // Add workflow hints
    if (fragments.length > 0) {
      response.workflow = {
        message: `Found ${fragments.length} relevant fragments using ${strategy} strategy`,
        suggested_next: [
          {
            description: 'Read the full file containing the most relevant fragment',
            command: 'vault read',
            reason: 'To see the complete context around the fragment'
          },
          {
            description: 'Search for related content',
            command: 'vault search',
            reason: 'To find other documents with similar content'
          }
        ]
      };
      
      // Add context information
      response.context = {
        search_results: fragments.length,
        linked_files: [...new Set(fragments.map(f => f.docPath))]
      };
    } else {
      response.workflow = {
        message: 'No relevant fragments found',
        suggested_next: [
          {
            description: 'Try a broader search query',
            command: 'vault search',
            reason: 'The current query may be too specific'
          },
          {
            description: 'List files in the vault',
            command: 'vault list',
            reason: 'To browse available content'
          }
        ]
      };
    }
    
    // Add efficiency hints based on strategy used
    if ((originalStrategy || strategy) === 'auto') {
      response.efficiency_hints = {
        message: `Auto-selected ${strategy} strategy based on query length`,
        alternatives: [
          'Use strategy:"adaptive" for keyword matching',
          'Use strategy:"proximity" for finding related terms',
          'Use strategy:"semantic" for conceptual search'
        ]
      };
    }
    
    return response;
  }
}