# Graph Tool Documentation

The `graph` tool enables AI to navigate and analyze your vault's link structure, understanding connections between notes.

## Core Concepts

Your Obsidian vault is a **knowledge graph** where:
- **Nodes** are your notes
- **Edges** are links between notes (both explicit links and tag connections)
- **Paths** are routes through the graph connecting concepts

## Actions

### Basic Navigation

#### `neighbors`
Get immediate connections of a note.
```json
{
  "action": "neighbors",
  "sourcePath": "concepts/machine-learning.md",
  "includeUnresolved": false  // Include links to non-existent notes
}
```

#### `traverse`
Explore connections up to a certain depth.
```json
{
  "action": "traverse",
  "sourcePath": "projects/current-project.md",
  "maxDepth": 3,  // How many hops from source
  "maxNodes": 50,  // Limit total nodes returned
  "followBacklinks": true,
  "followForwardLinks": true,
  "followTags": true
}
```

### Path Finding

#### `path`
Find connection paths between two notes.
```json
{
  "action": "path",
  "sourcePath": "philosophy/consciousness.md",
  "targetPath": "neuroscience/neural-networks.md"
}
```

### Analysis

#### `statistics`
Get graph statistics for a note or the entire vault.
```json
{
  "action": "statistics",
  "sourcePath": "index.md"  // Optional - omit for vault stats
}
```

Returns:
- Total links (in/out)
- Connectivity score
- Central nodes
- Orphaned notes

#### `backlinks`
Find all notes linking TO a specific note.
```json
{
  "action": "backlinks",
  "sourcePath": "concepts/important-idea.md"
}
```

#### `forwardlinks`
Find all notes linked FROM a specific note.
```json
{
  "action": "forwardlinks",
  "sourcePath": "index.md"
}
```

### Advanced Traversal

#### `search-traverse`
Combine search with graph traversal - find related content across connected notes.
```json
{
  "action": "search-traverse",
  "startPath": "research/ml-optimization.md",
  "searchQuery": "gradient descent",
  "maxDepth": 2,
  "maxSnippetsPerNode": 2,
  "scoreThreshold": 0.5
}
```

#### `advanced-traverse`
Sophisticated traversal with multiple search queries and strategies.
```json
{
  "action": "advanced-traverse",
  "sourcePath": "projects/thesis.md",
  "searchQueries": ["methodology", "results", "conclusion"],
  "strategy": "best-first",  // breadth-first, best-first, beam-search
  "beamWidth": 5,  // For beam-search
  "maxDepth": 4
}
```

#### `tag-traverse`
Navigate through tag connections.
```json
{
  "action": "tag-traverse",
  "sourcePath": "daily/2024-01-15.md",
  "tagFilter": ["#project", "#important"],
  "maxDepth": 3
}
```

#### `tag-analysis`
Analyze tag relationships and co-occurrences.
```json
{
  "action": "tag-analysis",
  "sourcePath": "index.md"  // Optional
}
```

#### `shared-tags`
Find notes sharing tags with a source note.
```json
{
  "action": "shared-tags",
  "sourcePath": "research/paper-1.md",
  "minSharedTags": 2  // Minimum tags in common
}
```

## Traversal Strategies

### Breadth-First
Explores all nodes at current depth before going deeper.
- **Use when**: You want comprehensive coverage
- **Best for**: Finding all related content

### Best-First
Prioritizes nodes with highest relevance scores.
- **Use when**: You want most relevant connections
- **Best for**: Focused research on specific topics

### Beam Search
Keeps only top N candidates at each level.
- **Use when**: You need balanced coverage with quality
- **Best for**: Large vaults where full traversal is expensive

## Filtering Options

### By Path
```json
{
  "fileFilter": "^research/.*\\.md$",  // Regex pattern
  "folderFilter": "projects/"  // Only include from this folder
}
```

### By Tags
```json
{
  "tagFilter": ["#important", "#review"],
  "tagWeight": 0.8  // How much to prioritize tag connections
}
```

### By Link Type
```json
{
  "followBacklinks": true,
  "followForwardLinks": true,
  "followTags": false,
  "includeUnresolved": false,
  "includeOrphans": false
}
```

## Use Cases

### Research Synthesis
Find all content related to a research topic across connected notes:
```json
{
  "action": "search-traverse",
  "startPath": "research/main-topic.md",
  "searchQuery": "key finding",
  "maxDepth": 3,
  "strategy": "best-first"
}
```

### Knowledge Mapping
Understand the structure around a concept:
```json
{
  "action": "traverse",
  "sourcePath": "concepts/central-idea.md",
  "maxDepth": 2,
  "followTags": true
}
```

### Missing Link Discovery
Find potential connections between unlinked notes:
```json
{
  "action": "shared-tags",
  "sourcePath": "ideas/new-idea.md",
  "minSharedTags": 3
}
```

### Impact Analysis
See what would be affected by changing a note:
```json
{
  "action": "backlinks",
  "sourcePath": "definitions/key-term.md"
}
```

## Best Practices

### Performance Optimization

1. **Limit depth for large vaults**: Start with depth 2-3
2. **Use filters aggressively**: Folder and tag filters reduce search space
3. **Set maxNodes appropriately**: Balance completeness with performance

### Effective Navigation

1. **Start from hub notes**: Index pages or MOCs (Maps of Content)
2. **Use multiple strategies**: Try different traversal strategies for different goals
3. **Combine with search**: `search-traverse` is powerful for topic exploration

### Graph Health

1. **Check for orphans regularly**: Use statistics to find disconnected notes
2. **Analyze backlinks**: High backlink counts indicate important notes
3. **Monitor link depth**: Very deep requirements might indicate poor organization