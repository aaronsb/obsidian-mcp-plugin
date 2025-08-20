# Obsidian Bases MCP Implementation Design

## Overview

Obsidian Bases is a new core plugin feature (v1.9.0+) that transforms note collections into powerful databases. This document outlines how to integrate Bases support into our MCP server.

## Key Bases Concepts

1. **Base Files**: `.base` file format containing database configuration
2. **Views**: Different visualizations of data (table, card view, etc.)
3. **Properties**: YAML frontmatter fields used as database columns
4. **Formulas**: Dynamic calculated properties
5. **Filters**: Query mechanisms to subset data
6. **Templates**: Automatic note generation with inherited properties

## Proposed MCP Operations

### New `bases` Operation Category

```typescript
operation: 'bases'
actions:
  - list         // List all bases in vault
  - read         // Read base configuration and data
  - create       // Create new base from notes
  - update       // Update base configuration
  - delete       // Delete a base
  - query        // Query base with filters
  - view         // Get specific view of base
  - formula      // Calculate formula values
  - template     // Generate notes from base template
  - export       // Export base data (CSV, JSON)
```

## Implementation Architecture

### 1. ObsidianAPI Layer Extensions

```typescript
// New methods in ObsidianAPI class
class ObsidianAPI {
  // Base file operations
  async listBases(): Promise<BaseFile[]>
  async getBase(path: string): Promise<BaseData>
  async createBase(config: BaseConfig): Promise<BaseFile>
  async updateBase(path: string, config: BaseConfig): Promise<void>
  async deleteBase(path: string): Promise<void>
  
  // Base data operations
  async queryBase(path: string, filters: BaseFilter[]): Promise<BaseQueryResult>
  async getBaseView(path: string, viewName: string): Promise<BaseView>
  async calculateFormula(basePath: string, formula: string): Promise<any>
  async generateFromTemplate(basePath: string, template: BaseTemplate): Promise<TFile>
  async exportBase(path: string, format: 'csv' | 'json'): Promise<string>
}
```

### 2. Type Definitions

```typescript
interface BaseFile {
  path: string;
  name: string;
  views: string[];
  properties: BaseProperty[];
  noteCount: number;
  created: number;
  modified: number;
}

interface BaseConfig {
  name: string;
  source: string | string[]; // Folder paths or tags to include
  properties: BaseProperty[];
  views: BaseViewConfig[];
  filters?: BaseFilter[];
}

interface BaseProperty {
  key: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'list' | 'formula';
  formula?: string; // For calculated properties
  required?: boolean;
  defaultValue?: any;
}

interface BaseView {
  name: string;
  type: 'table' | 'card' | 'list' | 'calendar';
  columns?: string[]; // For table view
  sortBy?: string;
  groupBy?: string;
  filters?: BaseFilter[];
}

interface BaseFilter {
  property: string;
  operator: 'equals' | 'contains' | 'gt' | 'lt' | 'between' | 'in' | 'not';
  value: any;
}

interface BaseQueryResult {
  notes: BaseNote[];
  total: number;
  page?: number;
  pageSize?: number;
}

interface BaseNote {
  path: string;
  title: string;
  properties: Record<string, any>;
  content?: string; // Optional, for performance
}
```

### 3. Semantic Router Integration

```typescript
// Add to SemanticRouter.executeOperation()
case 'bases':
  return this.executeBasesOperation(action, params);

private async executeBasesOperation(action: string, params: any): Promise<any> {
  switch (action) {
    case 'list':
      return await this.api.listBases();
    case 'read':
      return await this.api.getBase(params.path);
    case 'create':
      return await this.api.createBase(params.config);
    case 'query':
      return await this.api.queryBase(params.path, params.filters);
    case 'view':
      return await this.api.getBaseView(params.path, params.viewName);
    case 'formula':
      return await this.api.calculateFormula(params.basePath, params.formula);
    case 'template':
      return await this.api.generateFromTemplate(params.basePath, params.template);
    case 'export':
      return await this.api.exportBase(params.path, params.format);
    // ... other actions
  }
}
```

### 4. Implementation Phases

#### Phase 1: Read-Only Operations (MVP)
- List bases in vault
- Read base configuration
- Query base data with filters
- Get different views

#### Phase 2: Base Management
- Create new bases
- Update base configuration
- Delete bases
- Export functionality

#### Phase 3: Advanced Features
- Formula calculation
- Template-based note generation
- Real-time updates
- Performance optimization with caching

## Technical Considerations

### 1. File Format Handling
- Parse `.base` files (likely JSON or YAML format)
- Handle base file validation
- Maintain backward compatibility

### 2. Performance
- Cache base data for frequent queries
- Implement pagination for large datasets
- Use indexes for property-based filtering

### 3. Integration Points
- Leverage existing Obsidian vault API
- Reuse property extraction from frontmatter
- Integrate with existing search functionality

### 4. Error Handling
- Handle missing bases gracefully
- Validate property types
- Provide meaningful error messages

## Example Usage

### List All Bases
```json
{
  "operation": "bases",
  "action": "list"
}
```

### Query Base with Filters
```json
{
  "operation": "bases",
  "action": "query",
  "params": {
    "path": "Projects.base",
    "filters": [
      {
        "property": "status",
        "operator": "equals",
        "value": "active"
      },
      {
        "property": "priority",
        "operator": "in",
        "value": ["high", "critical"]
      }
    ]
  }
}
```

### Create Base from Folder
```json
{
  "operation": "bases",
  "action": "create",
  "params": {
    "config": {
      "name": "Reading List",
      "source": "Books/",
      "properties": [
        { "key": "title", "type": "text", "required": true },
        { "key": "author", "type": "text" },
        { "key": "rating", "type": "number" },
        { "key": "finished", "type": "checkbox" },
        { "key": "pages", "type": "number" },
        { "key": "progress", "type": "formula", "formula": "{{pages_read}} / {{pages}} * 100" }
      ],
      "views": [
        {
          "name": "All Books",
          "type": "table",
          "columns": ["title", "author", "rating", "finished"]
        },
        {
          "name": "Reading Now",
          "type": "card",
          "filters": [
            { "property": "finished", "operator": "equals", "value": false }
          ]
        }
      ]
    }
  }
}
```

## Benefits for MCP Clients

1. **Structured Data Access**: Query vault content as databases
2. **Dynamic Views**: Get different perspectives on notes
3. **Automation**: Generate notes with consistent structure
4. **Export Capabilities**: Extract data for external processing
5. **Performance**: Optimized queries vs full-text search

## Testing Strategy

1. **Unit Tests**: Test each ObsidianAPI method
2. **Integration Tests**: Test semantic router integration
3. **Performance Tests**: Benchmark large base queries
4. **Compatibility Tests**: Ensure works with different Obsidian versions

## Migration Path

1. Detect if Bases plugin is available
2. Provide graceful degradation for older Obsidian versions
3. Clear feature flags for Bases-specific operations
4. Documentation for client applications

## Next Steps

1. ✅ Research Bases feature documentation
2. ✅ Analyze current codebase structure
3. ✅ Design MCP operations for Bases
4. ⏳ Implement ObsidianAPI extensions
5. ⏳ Add semantic router handlers
6. ⏳ Create comprehensive tests
7. ⏳ Update documentation
8. ⏳ Release as beta feature