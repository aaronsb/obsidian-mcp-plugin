# Bases Implementation Fixes Required

## Critical Issues to Fix

### 1. ❌ File Format (HIGH PRIORITY)
**Current:** Using JSON format
**Required:** YAML format
**Fix:** 
- Install `js-yaml` package
- Update `parseBaseFile` to use YAML.parse
- Update `createBase` to use YAML.stringify
- Update type definitions to match YAML structure

### 2. ❌ Property Access (HIGH PRIORITY)
**Current:** Direct property access (`properties.status`)
**Required:** Prefixed access (`note.status`, `file.name`, `formula.progress`)
**Fix:**
- Implement property resolver that handles prefixes
- Map `note.*` to frontmatter properties
- Map `file.*` to file metadata
- Map `formula.*` to calculated values

### 3. ❌ Filter System (HIGH PRIORITY)
**Current:** Object-based filters with operators
```typescript
{ property: "status", operator: "equals", value: "active" }
```
**Required:** Expression strings
```yaml
'status == "active"'
```
**Fix:**
- Implement expression parser (or use existing library)
- Support JavaScript-like expressions
- Handle function calls like `file.hasTag("project")`
- Support logical operators (&&, ||, !)

### 4. ❌ Source/Folder Handling (MEDIUM PRIORITY)
**Current:** `source: "Projects/"` in config
**Required:** No source field - use filters instead
```yaml
filters:
  file.inFolder("Projects")
```
**Fix:**
- Remove `source` from BaseConfig type
- Always scan entire vault
- Use filters to narrow results
- Implement `file.inFolder()` function

### 5. ❌ Formula Engine (MEDIUM PRIORITY)
**Current:** No formula support
**Required:** Full expression evaluation
**Fix:**
- Implement formula evaluator
- Support arithmetic operators
- Support date arithmetic
- Support function calls
- Cache formula results

### 6. ❌ Metadata Cache Usage (HIGH PRIORITY)
**Current:** Not properly using Obsidian's metadata cache
**Required:** Use cache for frontmatter and file properties
**Fix:**
```typescript
const cache = this.app.metadataCache.getFileCache(file);
const frontmatter = cache?.frontmatter || {};
```

### 7. ❌ View Types (LOW PRIORITY)
**Current:** Generic view types
**Required:** Specific view configurations
**Fix:**
- Support `table` and `cards` layouts
- Handle view-specific properties (columns, imageProperty, etc.)

## Implementation Steps

### Phase 1: Core Fixes (Must Have)
1. **Install dependencies**
   ```bash
   npm install js-yaml @types/js-yaml
   ```

2. **Update BasesAPI class**
   - Fix YAML parsing
   - Implement property resolver
   - Fix metadata cache usage

3. **Create expression evaluator**
   - Parse filter expressions
   - Evaluate against note context
   - Support built-in functions

### Phase 2: Formula Support
1. **Create FormulaEngine class**
   - Parse formula expressions
   - Handle dependencies
   - Cache results

2. **Implement built-in functions**
   - Date functions
   - String functions
   - List functions
   - File functions

### Phase 3: Advanced Features
1. **Embedded bases** (code blocks)
2. **Template generation**
3. **Performance optimization**

## Updated Type Definitions

```typescript
interface BaseConfig {
  filters?: FilterExpression;
  formulas?: Record<string, string>;
  properties?: Record<string, PropertyConfig>;
  views: ViewConfig[];
}

interface PropertyConfig {
  displayName?: string;
}

interface ViewConfig {
  type: 'table' | 'cards';
  name: string;
  filters?: FilterExpression;
  order?: string[];
  limit?: number;
  // Table specific
  columns?: string[];
  // Cards specific
  imageProperty?: string;
  imageFit?: 'cover' | 'contain';
  imageAspectRatio?: string;
}

type FilterExpression = 
  | string // Expression like 'status == "active"'
  | { and: FilterExpression[] }
  | { or: FilterExpression[] }
  | { not: FilterExpression[] };
```

## Test Cases

### Test Base 1: Simple Project Tracker
```yaml
views:
  - type: table
    name: "All Projects"
```

### Test Base 2: Filtered View
```yaml
filters:
  file.inFolder("Projects")
views:
  - type: table
    name: "Active"
    filters:
      'status == "active"'
```

### Test Base 3: With Formulas
```yaml
formulas:
  days_left: '(due_date - now()) / 86400000'
views:
  - type: table
    name: "Deadline"
    order:
      - formula.days_left
```

## Code Examples

### Property Resolver
```typescript
private resolveProperty(context: NoteContext, path: string): any {
  if (path.startsWith('file.')) {
    const prop = path.substring(5);
    return this.getFileProperty(context.file, prop);
  } else if (path.startsWith('note.')) {
    const prop = path.substring(5);
    return context.frontmatter[prop];
  } else if (path.startsWith('formula.')) {
    const formula = path.substring(8);
    return this.evaluateFormula(context, formula);
  } else {
    // Default to note property
    return context.frontmatter[path];
  }
}
```

### Expression Evaluator
```typescript
private evaluateExpression(expr: string, context: NoteContext): boolean {
  // Parse expression
  const ast = this.parseExpression(expr);
  
  // Evaluate AST
  return this.evaluateAST(ast, context);
}

private parseExpression(expr: string): ExpressionAST {
  // Use a proper expression parser library
  // or implement basic tokenizer/parser
}
```

### File Functions
```typescript
private fileFunctions = {
  hasTag: (file: TFile, ...tags: string[]) => {
    const cache = this.app.metadataCache.getFileCache(file);
    const fileTags = getAllTags(cache) || [];
    return tags.some(tag => fileTags.includes(tag));
  },
  
  inFolder: (file: TFile, folder: string) => {
    return file.path.startsWith(folder + '/');
  },
  
  hasLink: (file: TFile, target: string) => {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache?.links?.some(link => link.link === target) || false;
  }
};
```

## Priority Order

1. **Fix YAML format** - Base files won't work without this
2. **Fix property access** - Can't read note data properly
3. **Fix filter expressions** - Can't filter notes
4. **Fix metadata cache** - Can't get frontmatter
5. **Add formula support** - Enhanced functionality
6. **Add remaining functions** - Complete feature set

## Success Criteria

- [ ] Can create .base files in YAML format
- [ ] Can read frontmatter properties with proper prefixes
- [ ] Can evaluate filter expressions
- [ ] Can apply filters to narrow results
- [ ] Can evaluate formulas
- [ ] Can export data in multiple formats
- [ ] All tests pass with actual Bases syntax