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
  async indexDocument(docId: string, filePath: string, content: string, metadata?: any): Promise<void> {
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
  ): Promise<SemanticResponse<{ fragments: Fragment[], strategy: string, totalFragments: number }>> {
    const { strategy = 'auto', maxFragments = 5 } = options;

    let fragments: Fragment[] = [];
    let selectedStrategy: string = strategy;

    if (strategy === 'auto') {
      // Choose strategy based on query characteristics
      selectedStrategy = this.selectOptimalStrategy(query);
    }

    // Execute the selected strategy
    switch (selectedStrategy) {
      case 'adaptive':
        fragments = await this.adaptiveIndex.search(query, maxFragments);
        break;

      case 'proximity':
        fragments = await this.proximityIndex.searchWithProximity(query);
        break;

      case 'semantic':
        fragments = await this.semanticIndex.searchWithContext(query, { maxFragments });
        break;

      default:
        // Hybrid approach - combine results from multiple strategies
        fragments = await this.hybridSearch(query, maxFragments);
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

  private async hybridSearch(query: string, maxFragments: number): Promise<Fragment[]> {
    // Get results from all strategies
    const [adaptiveResults, proximityResults, semanticResults] = await Promise.all([
      this.adaptiveIndex.search(query, maxFragments * 2),
      this.proximityIndex.searchWithProximity(query),
      this.semanticIndex.searchWithContext(query, { maxFragments: maxFragments * 2 })
    ]);

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
  ): SemanticResponse<{ fragments: Fragment[], strategy: string, totalFragments: number }> {
    // Simplified response as requested
    return {
      result: {
        fragments,
        strategy,
        totalFragments: fragments.length
      }
    };
  }
}