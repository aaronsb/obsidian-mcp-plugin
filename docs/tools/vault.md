# Vault Tool Documentation

The `vault` tool provides comprehensive file operations for your Obsidian vault.

## Actions

### Basic File Operations

#### `list`
List files in a directory.
```json
{
  "action": "list",
  "directory": "path/to/folder"  // Optional, defaults to root
}
```

#### `read`
Read a file's content.
```json
{
  "action": "read",
  "path": "notes/example.md"
}
```

#### `create`
Create a new file.
```json
{
  "action": "create",
  "path": "notes/new-note.md",
  "content": "# New Note\n\nContent here..."
}
```

#### `update`
Replace a file's content.
```json
{
  "action": "update",
  "path": "notes/existing.md",
  "content": "Updated content..."
}
```

#### `delete`
Delete a file.
```json
{
  "action": "delete",
  "path": "notes/old-note.md"
}
```

### Search Operations

#### `search`
Advanced search with multiple operators.
```json
{
  "action": "search",
  "query": "machine learning",
  "includeContent": true  // Include file content in results
}
```

**Search Operators:**
- `tag:#tagname` - Search by tag
- `path:folder/` - Search in specific path
- `file:filename` - Search by filename
- `content:term` - Search in content
- `"exact phrase"` - Exact phrase matching
- `/regex/` - Regular expression
- `term1 OR term2` - Boolean OR

#### `fragments`
Get relevant fragments from files matching a query.
```json
{
  "action": "fragments",
  "query": "optimization algorithms",
  "strategy": "semantic",  // auto, adaptive, proximity, semantic
  "maxFragments": 5
}
```

### File Management

#### `move`
Move a file to a new location.
```json
{
  "action": "move",
  "path": "notes/old-location.md",
  "destination": "archive/new-location.md"
}
```

#### `rename`
Rename a file (keeping it in the same directory).
```json
{
  "action": "rename",
  "path": "notes/old-name.md",
  "newName": "new-name.md"
}
```

#### `copy`
Create a copy of a file.
```json
{
  "action": "copy",
  "path": "templates/template.md",
  "destination": "notes/new-from-template.md"
}
```

### Advanced Operations

#### `split`
Split a file into multiple files.
```json
{
  "action": "split",
  "path": "notes/large-file.md",
  "splitBy": "heading",  // heading, delimiter, lines, size
  "level": 2,  // For heading split - split at ## headers
  "outputPattern": "{filename}-{index}{ext}"
}
```

#### `combine`
Combine multiple files into one.
```json
{
  "action": "combine",
  "paths": ["notes/part1.md", "notes/part2.md", "notes/part3.md"],
  "destination": "notes/combined.md",
  "separator": "\n\n---\n\n",
  "includeFilenames": true
}
```

#### `concatenate`
Append one file to another.
```json
{
  "action": "concatenate",
  "path1": "notes/main.md",
  "path2": "notes/addition.md",
  "mode": "append"  // append, prepend, or new
}
```

## Best Practices

### Search Strategies

1. **Start broad, then narrow**: Begin with simple terms, add operators to refine
2. **Use fragments for context**: When you need surrounding context, not just file names
3. **Combine operators**: `tag:#project AND path:work/ "deadline"`

### File Organization

1. **Use consistent naming**: Makes search and navigation easier
2. **Leverage folders**: Group related notes for targeted searches
3. **Regular maintenance**: Use split/combine to reorganize large files

### Performance Tips

1. **Limit search scope**: Use `path:` to search specific folders
2. **Use `includeContent: false`**: For faster searches when content isn't needed
3. **Batch operations**: Combine multiple files in one operation rather than many

## Common Patterns

### Research Collection
```json
// Find all research notes and combine them
{
  "action": "search",
  "query": "tag:#research path:studies/",
  "includeContent": false
}
// Then combine the results...
```

### Archive Old Notes
```json
// Move notes older than a certain date
{
  "action": "move",
  "path": "daily/2023-01-15.md",
  "destination": "archive/2023/01/15.md"
}
```

### Extract Sections
```json
// Split a large reference file by topics
{
  "action": "split",
  "path": "references/all-citations.md",
  "splitBy": "heading",
  "level": 1,
  "outputDirectory": "references/by-topic/"
}
```