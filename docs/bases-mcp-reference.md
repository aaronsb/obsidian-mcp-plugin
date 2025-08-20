# Obsidian Bases MCP Reference

## Overview

Obsidian Bases is a core plugin that transforms collections of notes into powerful databases. Bases work with your existing Markdown files and their frontmatter properties, providing views, filters, and formulas without requiring any coding knowledge.

## Key Concepts

### What Bases Are
- **NOT a separate plugin** - Bases is a core Obsidian feature (v1.9.0+)
- **File format**: `.base` files containing YAML configuration
- **Data source**: Reads properties from note frontmatter
- **No explicit source**: Bases work on entire vault by default, narrowed by filters

### Base File Structure (YAML)
```yaml
filters:          # Global filters for all views
  and:
    - file.hasTag("project")
    - 'status != "archived"'

formulas:         # Calculated properties
  days_left: '(due_date - now()) / 86400000'
  progress_pct: 'completion + "%"'

properties:       # Property display configuration
  status:
    displayName: "Project Status"
  formula.days_left:
    displayName: "Days Remaining"

views:           # Different ways to display data
  - type: table
    name: "Active Projects"
    filters:
      and:
        - 'priority <= 2'
    order:
      - priority
      - due_date
```

## Property Types

### Note Properties (`note.*` or no prefix)
- Stored in YAML frontmatter
- Examples: `status`, `priority`, `note.author`

### File Properties (`file.*`)
- Metadata about the file itself
- Available properties:
  - `file.name` - filename without extension
  - `file.path` - full path
  - `file.folder` - parent folder
  - `file.ext` - file extension
  - `file.size` - file size in bytes
  - `file.ctime` - creation time
  - `file.mtime` - modification time
  - `file.tags` - all tags in file
  - `file.links` - all internal links
  - `file.backlinks` - files linking to this one

### Formula Properties (`formula.*`)
- Calculated from other properties
- Defined in base configuration
- Can reference other formulas (no circular refs)

## Filter Syntax

### Expression Filters
```yaml
# Simple comparisons
- 'status == "active"'
- 'priority < 3'
- 'due_date > now()'

# Functions
- file.hasTag("important")
- file.inFolder("Projects")
- file.hasLink("[[Goals]]")

# Complex expressions
- '(priority <= 2) && (status != "done")'
```

### Logical Operators
```yaml
and:  # All conditions must be true
  - 'status == "active"'
  - 'priority <= 2'

or:   # Any condition must be true
  - file.hasTag("urgent")
  - 'due_date < today() + "7d"'

not:  # None of the conditions must be true
  - 'status == "archived"'
  - file.inFolder("Archive")
```

## MCP Operations

### `bases` Operation

#### `capabilities`
Check if Bases functionality is available (always true for Obsidian 1.9.0+)

**Response:**
```json
{
  "available": true,
  "version": "1.9.0",
  "features": {
    "formulas": true,
    "templates": true,
    "export": true,
    "customViews": true
  }
}
```

#### `list`
List all `.base` files in the vault

**Response:**
```json
[
  {
    "path": "Project Tracker.base",
    "name": "Project Tracker",
    "views": ["Active", "Completed", "By Priority"],
    "noteCount": 42
  }
]
```

#### `read`
Get the full configuration of a base

**Parameters:**
- `path` (string): Path to the .base file

**Response:**
```json
{
  "filters": {...},
  "formulas": {...},
  "properties": {...},
  "views": [...]
}
```

#### `create`
Create a new base file

**Parameters:**
- `config` (object): Base configuration in proper format
  - `filters` (optional): Global filters
  - `formulas` (optional): Formula definitions
  - `properties` (optional): Property configurations
  - `views` (required): Array of view definitions

**Example:**
```json
{
  "config": {
    "filters": {
      "and": [
        "file.hasTag('project')"
      ]
    },
    "views": [
      {
        "type": "table",
        "name": "All Projects"
      }
    ]
  }
}
```

#### `query`
Execute a query against a base

**Parameters:**
- `path` (string): Path to the .base file
- `viewName` (optional): Specific view to use
- `additionalFilters` (optional): Extra filters to apply

**Response:**
```json
{
  "notes": [
    {
      "path": "Projects/Website.md",
      "title": "Website Redesign",
      "properties": {
        "status": "active",
        "priority": 1,
        "formula.days_left": 45
      }
    }
  ],
  "total": 12
}
```

#### `view`
Get data for a specific view

**Parameters:**
- `path` (string): Path to the .base file
- `viewName` (string): Name of the view

**Response:**
```json
{
  "name": "Active Projects",
  "type": "table",
  "data": [...],
  "columns": ["title", "status", "priority"],
  "total": 8
}
```

#### `evaluate`
Evaluate a formula expression

**Parameters:**
- `expression` (string): Formula to evaluate
- `context` (object): Note properties for evaluation

**Example:**
```json
{
  "expression": "(due_date - now()) / 86400000",
  "context": {
    "due_date": "2025-03-15"
  }
}
```

#### `export`
Export base data

**Parameters:**
- `path` (string): Path to the .base file
- `format` (string): "csv", "json", or "markdown"
- `viewName` (optional): Specific view to export

## Common Use Cases

### Project Management Base
```yaml
filters:
  file.inFolder("Projects")
  
formulas:
  days_until_due: '(due_date - now()) / 86400000'
  is_overdue: 'due_date < now()'
  team_members: 'team_size + " people"'

views:
  - type: table
    name: "Active Projects"
    filters:
      and:
        - 'status == "active"'
    order:
      - priority
      - due_date
      
  - type: cards
    name: "Overdue"
    filters:
      and:
        - 'formula.is_overdue == true'
        - 'status != "completed"'
```

### Reading List Base
```yaml
filters:
  file.hasTag("book")
  
formulas:
  pages_left: 'total_pages - pages_read'
  percent_complete: '(pages_read / total_pages * 100).round() + "%"'
  
views:
  - type: table
    name: "Currently Reading"
    filters:
      and:
        - 'status == "reading"'
    order:
      - formula.percent_complete
      
  - type: cards
    name: "To Read"
    filters:
      and:
        - 'status == "want-to-read"'
    limit: 10
```

### Task Tracker Base
```yaml
filters:
  or:
    - file.hasTag("task")
    - 'type == "task"'
    
formulas:
  is_urgent: '(priority == 1) || (due_date < today() + "3d")'
  age_days: '(now() - file.ctime) / 86400000'
  
views:
  - type: table
    name: "Today's Tasks"
    filters:
      and:
        - 'due_date == today()'
        - 'completed != true'
    order:
      - priority
      
  - type: table
    name: "Urgent"
    filters:
      formula.is_urgent == true
```

## Functions Reference

### Global Functions
- `date(string)` - Parse date string
- `now()` - Current date/time
- `today()` - Current date (no time)
- `if(condition, true_result, false_result)`
- `link(path, display?)` - Create link
- `file(path)` - Get file object
- `list(element)` - Convert to list
- `number(value)` - Convert to number

### String Functions
- `string.contains(value)`
- `string.toLowerCase()`
- `string.toUpperCase()`
- `string.trim()`
- `string.split(separator)`
- `string.replace(pattern, replacement)`

### Number Functions
- `number.round(digits?)`
- `number.toFixed(precision)`
- `number.abs()`

### Date Functions
- `date.format(format_string)`
- `date.date()` - Get date portion
- `date.time()` - Get time portion
- `date.relative()` - Human-readable relative time

### List Functions
- `list.contains(value)`
- `list.join(separator)`
- `list.length`
- `list.unique()`
- `list.sort()`

### File Functions
- `file.hasTag(...tags)`
- `file.hasLink(target)`
- `file.inFolder(folder)`
- `file.hasProperty(name)`

## Important Notes

1. **Bases is NOT a plugin** - It's a core Obsidian feature, always available in v1.9.0+
2. **YAML not JSON** - Base files use YAML format
3. **No explicit source** - Bases query entire vault, use filters to narrow
4. **Expression strings** - Filters use JavaScript-like expressions, not objects
5. **Property prefixes** - Use `note.`, `file.`, `formula.` prefixes
6. **Performance** - `file.backlinks` is expensive, prefer `file.links`
7. **Context with `this`** - In embedded bases, `this` refers to current file

## Error Handling

Common errors and solutions:

- **"Invalid YAML"** - Check base file syntax
- **"Unknown property"** - Verify property exists in frontmatter
- **"Circular formula reference"** - Check formula dependencies
- **"Invalid filter expression"** - Verify filter syntax
- **"Type mismatch"** - Ensure correct types in comparisons

## Migration from Dataview

| Dataview | Bases |
|----------|-------|
| `FROM "folder"` | `filters: file.inFolder("folder")` |
| `WHERE status = "active"` | `filters: 'status == "active"'` |
| `SORT priority ASC` | `order: [priority]` |
| `TABLE` query | `type: table` view |
| Inline queries | Embedded base code blocks |