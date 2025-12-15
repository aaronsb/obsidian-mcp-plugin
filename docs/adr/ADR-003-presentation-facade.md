# ADR-003: Presentation Facade for MCP Tool Output

## Status
Proposed

## Date
2025-12-15

## Context

Currently, all MCP tool responses return raw JSON structures. While "honest" and precise, this approach has drawbacks:

1. **Token inefficiency** - Verbose JSON consumes context window
2. **Cognitive load** - AI agents must parse nested structures to understand results
3. **Noise** - Internal metadata (workflow hints, context objects) clutters responses
4. **Inconsistency** - Different tools return different structures

Example of current verbose output:
```json
{
  "result": {
    "query": "architecture",
    "page": 1,
    "pageSize": 5,
    "totalResults": 26,
    "totalPages": 6,
    "results": [
      {
        "path": "Synthesis/Thought-Architecture.md",
        "title": "Thought-Architecture",
        "score": 2.157798929344319,
        "snippet": {
          "content": "...",
          "lineStart": 10,
          "lineEnd": 11,
          "score": 0.30102999566398114
        },
        "metadata": {
          "size": 1618,
          "modified": 1751293160515,
          "extension": "md"
        }
      }
    ],
    "method": "facade-ranked-combined",
    "workflow": { ... }
  },
  "workflow": { ... },
  "context": { ... }
}
```

The [knowledge-graph-system](https://github.com/aaronsb/knowledge-graph-system) MCP server uses a presentation facade that converts API responses to clean, AI-readable markdown. This approach has proven effective for AI comprehension while reducing token usage.

## Decision

Implement a **Presentation Facade** that formats all MCP tool output as structured markdown text, optimized for AI consumption.

### Design Principles

1. **Token Efficiency** - Reduce output size by 50-70% through intelligent formatting
2. **Interpretive** - Convert raw values to meaningful text (0.75 → "Strong (75%)")
3. **Structured** - Use markdown headers and lists for clear hierarchy
4. **Actionable** - Include brief tips for follow-up operations when relevant
5. **Consistent** - All tools follow same formatting patterns

### Output Format

```markdown
# Search: "architecture"

Found 26 results (showing 1-5, page 1 of 6)

## Results

1. **Thought-Architecture.md** (Excellent, 2.16)
   Path: Synthesis/Thought-Architecture.md
   Snippet: "...thought-architecture #spatial-pkm #design-thinking..."

2. **Dendron-Architecture.md** (Excellent, 2.14)
   Path: Tools/Dendron-Architecture.md
   Snippet: "...maintain a scalable, maintainable knowledge architecture..."

---
Tip: Use `page: 2` for more results.
Tip: Use `vault.read(path)` or `view.file(path)` to see full content.

_Summary view. For all metadata fields, use `raw: true`._
```

### Formatters to Implement

| Tool | Formatter | Key Transformations |
|------|-----------|---------------------|
| `vault.search` | `formatSearchResults()` | Score interpretation, snippet truncation |
| `vault.read` | `formatFileContent()` | Frontmatter summary, content preview |
| `vault.list` | `formatFileList()` | Tree structure, file counts |
| `view.file` | `formatFileView()` | Line numbers, content window |
| `graph.traverse` | `formatGraphTraversal()` | Node hierarchy, link visualization |
| `graph.path` | `formatGraphPath()` | ASCII path diagram |
| `dataview.query` | `formatDataviewResults()` | Table formatting |
| `system.info` | `formatSystemInfo()` | Status summary |

### Formatting Techniques

**Score Interpretation**
```typescript
const interpretScore = (score: number): string => {
  if (score >= 2.0) return `Excellent (${score.toFixed(2)})`;
  if (score >= 1.0) return `Good (${score.toFixed(2)})`;
  if (score >= 0.5) return `Moderate (${score.toFixed(2)})`;
  return `Low (${score.toFixed(2)})`;
};
```

**Truncation**
```typescript
const truncate = (text: string, maxLen: number = 120): string => {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
};
```

**Markdown Structure**
```typescript
const formatHeader = (level: number, text: string): string =>
  '#'.repeat(level) + ' ' + text + '\n\n';

const formatList = (items: string[]): string =>
  items.map((item, i) => `${i + 1}. ${item}`).join('\n');
```

### Integration Pattern

```typescript
// In semantic-tools.ts handler
const response = await router.route(request);

// Apply presentation formatting
const formattedText = formatResponse(operation, action, response);

return {
  content: [{
    type: 'text',
    text: formattedText
  }]
};
```

### Backward Compatibility

Add a `raw: true` option to return unformatted JSON for tools that need structured data:

```typescript
vault.search("query", { raw: true })  // Returns JSON
vault.search("query")                  // Returns formatted markdown
```

## Consequences

### Benefits
- **Reduced token usage** - 50-70% smaller responses
- **Better AI comprehension** - Clear structure, interpreted values
- **Consistent UX** - All tools follow same patterns
- **Actionable guidance** - Tips help AI chain operations

### Drawbacks
- **Additional code layer** - Formatters to maintain
- **Testing complexity** - Need to test both formatted and raw outputs

### Addressing Data Availability

Formatted output omits verbose metadata for token efficiency. To prevent AI confusion when data seems missing, each formatted response includes a semantic hint:

```markdown
---
Note: This is a formatted summary. Use `raw: true` for complete JSON with all metadata fields.
```

This pattern:
- **Guides discovery** - AI learns about `raw: true` option naturally
- **Sets expectations** - Clear that this is a summary, not complete data
- **Provides escape hatch** - Verbose JSON available when needed

### Migration
- Phase 1: Add formatters alongside existing JSON output
- Phase 2: Make formatted output default
- Phase 3: Document `raw: true` option for edge cases

## Implementation

### File Structure
```
src/
├── formatters/
│   ├── index.ts           # Export all formatters
│   ├── search.ts          # Search result formatting
│   ├── vault.ts           # File operations formatting
│   ├── graph.ts           # Graph operations formatting
│   ├── dataview.ts        # Dataview formatting
│   └── utils.ts           # Shared formatting utilities
└── tools/
    └── semantic-tools.ts  # Integration point
```

### Example: Search Formatter

```typescript
// src/formatters/search.ts

export interface SearchResponse {
  query: string;
  page: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  results: SearchResult[];
  method: string;
}

export function formatSearchResults(response: SearchResponse): string {
  const { query, page, pageSize, totalResults, totalPages, results } = response;

  const lines: string[] = [];

  // Header
  lines.push(`# Search: "${query}"`);
  lines.push('');

  if (totalResults === 0) {
    lines.push('No results found.');
    lines.push('');
    lines.push('Tip: Try broader terms, or use operators like `tag:#topic` or `path:folder`');
    return lines.join('\n');
  }

  // Summary
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalResults);
  lines.push(`Found ${totalResults} results (showing ${start}-${end}, page ${page} of ${totalPages})`);
  lines.push('');

  // Results
  lines.push('## Results');
  lines.push('');

  results.forEach((result, i) => {
    lines.push(`${start + i}. **${result.title}** (${interpretScore(result.score)})`);
    lines.push(`   Path: ${result.path}`);
    if (result.snippet?.content) {
      lines.push(`   Snippet: "${truncate(result.snippet.content, 80)}"`);
    }
    lines.push('');
  });

  // Tips and hints
  lines.push('---');
  if (page < totalPages) {
    lines.push(`Tip: Use \`page: ${page + 1}\` for more results.`);
  }
  lines.push('Tip: Use `vault.read(path)` or `view.file(path)` to see full content.');
  lines.push('');
  lines.push('_Summary view. For all metadata fields, use `raw: true`._');

  return lines.join('\n');
}
```

## References

- [Knowledge Graph System Formatters](https://github.com/aaronsb/knowledge-graph-system/blob/main/cli/src/mcp/formatters.ts)
- ADR-002: Search Facade Architecture
- MCP Specification: Tool Response Format
