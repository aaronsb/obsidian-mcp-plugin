/**
 * Types for the fragment retrieval system
 */

export interface Fragment {
  id: string;
  docId: string;
  docPath: string; // Full path to the source document
  content: string;
  score: number;
  lineStart: number; // Starting line number in the source document
  lineEnd: number;   // Ending line number in the source document
  metadata?: Record<string, unknown>;
  context?: {
    before?: string;
    after?: string;
    related?: Array<{ id: string; preview: string }>;
  };
}

export interface ScoredFragment extends Fragment {
  localScore: number;
}

export interface LocalFragment {
  text: string;
  start: number;
  end: number;
  localScore: number;
}

export interface Document {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  length: number;
  uniqueTermCount: number;
}

export interface TermStatistics {
  documentFrequency: number;
  totalFrequency: number;
  averagePosition: number;
}

export interface Window {
  text: string;
  start: number;
  end: number;
}

export interface TermPositions {
  docId: string;
  start: number;
  end: number;
}

export interface TokenPosition {
  token: string;
  start: number;
  end: number;
}

export interface ProcessedDocument {
  id: string;
  content: string;
  tokens: string[];
  positions: TokenPosition[];
}

export interface PositionCluster {
  start: number;
  end: number;
  terms: Set<string>;
  positions: number[];
}

export interface Chunk {
  id: string;
  docId: string;
  content: string;
  context: {
    before: string;
    after: string;
    type: string;
  };
  metadata: {
    start: number;
    end: number;
    depth: number;
  };
}

export interface SemanticSegment {
  text: string;
  type: string;
  start: number;
  end: number;
  depth: number;
  before: string;
  after: string;
}

export interface ExpandedContext {
  before: string;
  after: string;
  related: Array<{ id: string; preview: string }>;
}

export interface SearchOptions {
  maxFragments?: number;
  includeContext?: boolean;
  expandNeighbors?: boolean;
}

export interface ContextualFragment extends Fragment {
  context?: ExpandedContext;
}

export interface FragmentRef {
  fragmentId: string;
  importance: number;
}

export interface RetrievalOptions {
  strategy?: 'auto' | 'adaptive' | 'proximity' | 'semantic';
  maxFragments?: number;
}