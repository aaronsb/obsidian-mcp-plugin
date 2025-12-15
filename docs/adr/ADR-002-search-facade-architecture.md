# ADR-002: Search Facade Architecture

Status: Proposed
Date: 2025-12-15
Deciders: @aaronsb, @claude

## Context

The codebase currently contains two search implementations:

1. **Operator-based search** (`obsidian-api.ts`) - Supports `file:`, `path:`, `content:`, `tag:` operators, regex patterns, and OR queries. Fast, uses Obsidian's metadataCache. No relevance scoring.

2. **AdvancedSearchService** (`advanced-search.ts`) - Token-based search with TF-IDF-like scoring, stop word removal, and snippet extraction. Not integrated into MCP tools.

Issue #63 identified gaps:
- AND operator documented but not implemented
- Multi-term queries treated as exact matches
- No relevance ranking for general queries
- AdvancedSearchService exists but is inaccessible

The naive solutions (replace one with the other, or expose both as separate tools) conflict with our "less tools, more details" principle and create maintenance burden.

## Decision

Implement a **Search Facade** that presents a unified interface to AI while internally composing different search strategies based on query characteristics and options.

### Facade Interface

```typescript
interface SearchOptions {
  // Relevance & ranking
  ranked?: boolean;           // Use TF-IDF scoring (default: false for operator queries, true otherwise)

  // Snippets
  includeSnippets?: boolean;  // Extract contextual snippets (default: true)
  snippetLength?: number;     // Max snippet length (default: 300)

  // Strategy
  strategy?: 'filename' | 'content' | 'combined' | 'auto';  // default: 'auto'

  // Limits
  maxResults?: number;        // default: 50

  // Content inclusion
  includeContent?: boolean;   // Include full file content in results
}
```

### Routing Logic

```
Query arrives
  ↓
Parse for operators (file:, tag:, path:, content:, OR, AND, /regex/)
  ↓
Has explicit operators?
  ├─ Yes: Use operator-based search (fast, precise)
  │       Apply ranked scoring as post-process if ranked=true
  │
  └─ No:  Natural language query
          Use AdvancedSearchService (tokenized, ranked)
  ↓
Extract snippets if requested
  ↓
Return unified SearchResult[]
```

### Unified Result Format

```typescript
interface SearchResult {
  path: string;
  title: string;
  score: number;              // 0-1 normalized relevance
  snippet?: {
    content: string;
    lineStart: number;
    lineEnd: number;
  };
  matches?: {                 // What matched
    filename?: boolean;
    content?: boolean;
    tags?: string[];
  };
  metadata?: {
    size: number;
    modified: number;
  };
}
```

### Backward Compatibility

- Existing operator syntax (`file:foo`, `tag:project`) continues to work
- Default behavior remains fast for simple queries
- `ranked: true` can be explicitly requested for any query type

## Consequences

### Positive
- Single search tool with rich options (aligns with "less tools, more details")
- AI gets relevance-ranked results for natural language queries
- Operator precision preserved for targeted searches
- Internal implementation can evolve without changing AI interface
- "Pee-wee Herman breakfast machine" - complex internally, simple externally

### Negative
- More complex routing logic to maintain
- Two search implementations to keep in sync
- Potential for subtle behavior differences between strategies

### Neutral
- AND operator implementation becomes part of this work
- Schema changes needed to expose new options
- Performance characteristics vary by query type (documented in tool description)

## Alternatives Considered

### A. Replace current search with AdvancedSearchService
- Rejected: Loses operator support, requires reimplementing all operators in new system

### B. Expose both as separate MCP tools
- Rejected: Violates "less tools" principle, forces AI to choose implementation

### C. Just fix AND operator in current search
- Rejected: Doesn't address relevance ranking gap, kicks can down road

### D. Mode parameter (`mode: 'quick' | 'ranked'`)
- Partially adopted: Options interface is more flexible than binary mode

## Implementation Plan

1. Create `SearchFacade` class in `src/utils/search-facade.ts`
2. Implement query parsing and routing logic
3. Integrate AdvancedSearchService for natural language queries
4. Add AND operator support to operator-based search
5. Update semantic-tools.ts schema with new options
6. Add tests for combined behavior
7. Update documentation

## References

- Issue #63: Search Implementation Gaps
- Research: `.claude/mcp-research.md` - "less tools, more details" principle
- PR #44: Rejected granular tools proposal (same principle applies)
