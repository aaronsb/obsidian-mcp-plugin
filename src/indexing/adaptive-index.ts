import {
  Document,
  Fragment,
  LocalFragment,
  ScoredFragment,
  TermStatistics
} from '../types/fragment';

/**
 * Adaptive text index with dynamic term frequency scoring
 * Self-contained, no external dependencies required
 */
export class AdaptiveTextIndex {
  private documents = new Map<string, Document>();
  private invertedIndex = new Map<string, Set<string>>();
  private termStats = new Map<string, TermStatistics>();
  private filePathMap = new Map<string, string>(); // docId -> filePath mapping

  indexDocument(docId: string, filePath: string, content: string, metadata?: Record<string, unknown>) {
    const lines = content.split('\n');
    const tokens = this.tokenize(content);
    const uniqueTerms = new Set(tokens);
    
    // Store document
    this.documents.set(docId, {
      id: docId,
      content,
      metadata: { ...metadata, lineCount: lines.length },
      length: tokens.length,
      uniqueTermCount: uniqueTerms.size
    });
    
    // Store file path mapping
    this.filePathMap.set(docId, filePath);
    
    // Build inverted index
    uniqueTerms.forEach(term => {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
      }
      this.invertedIndex.get(term)!.add(docId);
      
      // Track term statistics
      this.updateTermStats(term, tokens);
    });
  }
  
  search(query: string, maxFragments: number = 5): Fragment[] {
    // Handle undefined or empty query
    if (!query || query.trim().length === 0) {
      return [];
    }
    
    const queryTokens = this.tokenize(query);
    const candidateDocs = this.getCandidateDocuments(queryTokens);
    
    // If no candidate documents found, return empty
    if (candidateDocs.size === 0) {
      return [];
    }
    
    // Score documents
    const docScores = new Map<string, number>();
    candidateDocs.forEach(docId => {
      const score = this.scoreDocument(docId, queryTokens);
      if (score > 0) docScores.set(docId, score);
    });
    
    // Extract best fragments from top documents
    return this.extractFragments(docScores, queryTokens, maxFragments);
  }
  
  private extractFragments(
    docScores: Map<string, number>, 
    queryTokens: string[], 
    maxFragments: number
  ): Fragment[] {
    const fragments: ScoredFragment[] = [];
    
    // Get top scoring documents (at least 1)
    const topDocs = Array.from(docScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.ceil(maxFragments / 2)));
    
    for (const [docId, docScore] of topDocs) {
      const doc = this.documents.get(docId)!;
      const filePath = this.filePathMap.get(docId)!;
      const docFragments = this.findBestPassages(
        doc.content,
        queryTokens,
        400 // fragment size
      );
      
      fragments.push(...docFragments.map((f, idx) => ({
        id: `${docId}:frag${idx}`,
        docId,
        docPath: filePath,
        content: f.text,
        score: docScore > 0 ? docScore * f.localScore : f.localScore,
        localScore: f.localScore,
        lineStart: this.getLineNumber(doc.content, f.start),
        lineEnd: this.getLineNumber(doc.content, f.end),
        metadata: doc.metadata
      })));
    }
    
    return fragments
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFragments);
  }
  
  private findBestPassages(
    content: string, 
    queryTokens: string[], 
    fragmentSize: number
  ): LocalFragment[] {
    const sentences = this.splitIntoSentences(content);
    const windows: LocalFragment[] = [];
    
    // If no sentences found, create one from the entire content
    if (sentences.length === 0) {
      const score = this.scorePassage(content, queryTokens);
      if (score > 0) {
        return [{
          text: content.trim(),
          start: 0,
          end: content.length,
          localScore: score
        }];
      }
      return [];
    }
    
    // Create overlapping windows of sentences
    for (let i = 0; i < sentences.length; i++) {
      let window = sentences[i].text;
      const windowStart = sentences[i].start;
      let j = i + 1;
      
      while (j < sentences.length && window.length < fragmentSize) {
        window += ' ' + sentences[j].text;
        j++;
      }
      
      const score = this.scorePassage(window, queryTokens);
      if (score > 0) {
        windows.push({
          text: window,
          start: windowStart,
          end: sentences[Math.min(j - 1, sentences.length - 1)].end,
          localScore: score
        });
      }
    }
    
    // Remove overlapping windows, keeping highest scoring
    return this.deduplicateWindows(windows);
  }
  
  private tokenize(text: string): string[] {
    // Simple but effective tokenization
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }
  
  private getCandidateDocuments(queryTokens: string[]): Set<string> {
    const candidates = new Set<string>();
    
    // Get documents containing any query term
    queryTokens.forEach(term => {
      const docs = this.invertedIndex.get(term);
      if (docs) {
        docs.forEach(doc => candidates.add(doc));
      }
      
      // Also check for partial matches in the index
      this.invertedIndex.forEach((docSet, indexTerm) => {
        if (indexTerm.includes(term) || term.includes(indexTerm)) {
          docSet.forEach(doc => candidates.add(doc));
        }
      });
    });
    
    return candidates;
  }
  
  private scoreDocument(docId: string, queryTokens: string[]): number {
    const doc = this.documents.get(docId)!;
    const docTokens = this.tokenize(doc.content);
    let score = 0;
    
    // Calculate term frequency scores with flexible matching
    queryTokens.forEach(term => {
      const tf = docTokens.filter(t => 
        t === term || t.includes(term) || term.includes(t)
      ).length;
      if (tf > 0) {
        const df = this.invertedIndex.get(term)?.size || 0;
        const idf = Math.log((this.documents.size + 1) / (df + 1));
        score += (tf / docTokens.length) * idf;
      }
    });
    
    // Return raw score - normalization happens at fragment level
    return score > 0 ? score : 0.1; // Ensure non-zero score for documents with matches
  }
  
  private scorePassage(passage: string, queryTokens: string[]): number {
    const passageTokens = this.tokenize(passage);
    let score = 0;
    
    // Query term matching - make it more flexible
    queryTokens.forEach(term => {
      const matches = passageTokens.filter(t => 
        t === term || t.includes(term) || term.includes(t)
      ).length;
      score += matches * 2;
    });
    
    // Proximity bonus - reward passages where query terms appear close together
    const positions = new Map<string, number[]>();
    passageTokens.forEach((token, idx) => {
      if (queryTokens.includes(token)) {
        if (!positions.has(token)) positions.set(token, []);
        positions.get(token)!.push(idx);
      }
    });
    
    if (positions.size > 1) {
      const allPositions = Array.from(positions.values()).flat().sort((a, b) => a - b);
      for (let i = 1; i < allPositions.length; i++) {
        const distance = allPositions[i] - allPositions[i - 1];
        if (distance < 10) score += 5 / distance;
      }
    }
    
    // Boost for complete sentences
    const sentences = passage.match(/[.!?]\s/g)?.length || 0;
    score *= (1 + sentences * 0.1);
    
    return score;
  }
  
  private splitIntoSentences(content: string): Array<{ text: string; start: number; end: number }> {
    const sentences: Array<{ text: string; start: number; end: number }> = [];
    const regex = /[^.!?]+[.!?]+/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      sentences.push({
        text: match[0].trim(),
        start: match.index,
        end: match.index + match[0].length
      });
    }
    
    // Handle last sentence without punctuation
    if (sentences.length === 0 || sentences[sentences.length - 1].end < content.length) {
      const lastStart = sentences.length > 0 ? sentences[sentences.length - 1].end : 0;
      const lastText = content.substring(lastStart).trim();
      if (lastText) {
        sentences.push({
          text: lastText,
          start: lastStart,
          end: content.length
        });
      }
    }
    
    return sentences;
  }
  
  private deduplicateWindows(windows: LocalFragment[]): LocalFragment[] {
    windows.sort((a, b) => b.localScore - a.localScore);
    const selected: LocalFragment[] = [];
    
    for (const window of windows) {
      // Check if this window overlaps significantly with already selected ones
      const overlaps = selected.some(s => 
        (window.start >= s.start && window.start <= s.end) ||
        (window.end >= s.start && window.end <= s.end) ||
        (s.start >= window.start && s.start <= window.end)
      );
      
      if (!overlaps) {
        selected.push(window);
      }
    }
    
    return selected;
  }
  
  private updateTermStats(term: string, tokens: string[]) {
    const positions = tokens.map((t, i) => t === term ? i : -1).filter(p => p >= 0);
    const avgPosition = positions.reduce((a, b) => a + b, 0) / positions.length;
    
    if (!this.termStats.has(term)) {
      this.termStats.set(term, {
        documentFrequency: 0,
        totalFrequency: 0,
        averagePosition: 0
      });
    }
    
    const stats = this.termStats.get(term)!;
    stats.documentFrequency++;
    stats.totalFrequency += positions.length;
    stats.averagePosition = (stats.averagePosition + avgPosition) / 2;
  }
  
  private getLineNumber(content: string, position: number): number {
    const lines = content.substring(0, position).split('\n');
    return lines.length;
  }
}