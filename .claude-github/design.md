# Obsidian MCP Plugin - Architecture Design

## ADR-001: Bases Architecture Modernization

**Status**: Proposed  
**Date**: 2025-08-26  
**Requirement IDs**: Performance optimization, architectural compliance, extensibility requirements

## Context

The current Bases implementation, while functional, exhibits several architectural anti-patterns that limit scalability, maintainability, and performance:

### Current Architecture Issues
1. **Monolithic BasesAPI Class**: 440+ lines handling file parsing, query execution, export formatting, and property extraction
2. **Tight Coupling**: ExpressionEvaluator directly depends on Obsidian concrete types
3. **Performance Bottlenecks**: Full vault scans for every query, no caching, synchronous processing
4. **Security Concerns**: Direct eval() usage in expression evaluation without proper sandboxing
5. **Limited Extensibility**: Hard-coded export formats and view types

### SOLID Violations
- **SRP**: BasesAPI has multiple responsibilities (file ops, queries, formatting)
- **OCP**: Adding new view types or export formats requires modifying existing code
- **ISP**: No separation between different operational concerns
- **DIP**: Direct dependencies on Obsidian concrete implementations

## Decision

Implement a layered architecture with clear separation of concerns following SOLID principles:

### Layer 1: Core Interfaces (Domain Layer)
```typescript
interface IBaseRepository {
  findAll(): Promise<BaseConfig[]>;
  findByPath(path: string): Promise<BaseConfig>;
  create(config: BaseConfig): Promise<void>;
  update(path: string, config: BaseConfig): Promise<void>;
  delete(path: string): Promise<void>;
}

interface IQueryEngine {
  execute(query: BaseQuery): Promise<QueryResult>;
  count(query: BaseQuery): Promise<number>;
  explain(query: BaseQuery): QueryPlan;
}

interface IViewRenderer {
  render(result: QueryResult, config: ViewConfig): Promise<RenderedView>;
  supports(viewType: string): boolean;
}

interface IExportStrategy {
  export(result: QueryResult): Promise<string>;
  supports(format: string): boolean;
}
```

### Layer 2: Service Layer
```typescript
class BaseService {
  constructor(
    private repository: IBaseRepository,
    private queryEngine: IQueryEngine,
    private viewRenderers: Map<string, IViewRenderer>,
    private exportStrategies: Map<string, IExportStrategy>
  ) {}

  async listBases(): Promise<BaseInfo[]> { /* delegates to repository */ }
  async queryBase(path: string, viewName?: string): Promise<BaseQueryResult> { /* orchestrates query + view */ }
  async exportBase(path: string, format: string): Promise<string> { /* orchestrates query + export */ }
}
```

### Layer 3: Infrastructure Layer
```typescript
class ObsidianBaseRepository implements IBaseRepository {
  constructor(private api: ObsidianAPI) {}
  // Direct integration with vault operations
}

class IndexedQueryEngine implements IQueryEngine {
  constructor(
    private indexService: IIndexService,
    private evaluator: IExpressionEvaluator
  ) {}
  // Optimized query execution with indexing
}
```

## Consequences

### Positive
- **Testability**: Each component can be unit tested in isolation
- **Performance**: Dedicated query engine with indexing and caching
- **Extensibility**: New view types and export formats via plugin pattern
- **Security**: Sandboxed expression evaluation with controlled context
- **Maintainability**: Clear separation of concerns following SOLID principles

### Negative
- **Complexity**: More interfaces and classes to manage
- **Initial Development Cost**: Significant refactoring required
- **Learning Curve**: Team needs to understand layered architecture

### Neutral
- **Memory Usage**: Slight increase due to additional abstraction layers
- **Bundle Size**: Minimal impact on plugin size

## Alternatives Considered

1. **Incremental Refactoring**: Gradually improve existing code
   - Rejected: Doesn't address fundamental architectural issues
2. **External Query Library**: Use existing database/query libraries
   - Rejected: Adds dependencies and doesn't integrate well with Obsidian patterns
3. **Event-Driven Architecture**: Use pub/sub for loose coupling
   - Deferred: Would add complexity without clear benefits for current use cases

## Implementation Notes

### Phase 1: Core Architecture (2-3 weeks)
- Extract interfaces and core domain types
- Implement repository pattern for base file operations
- Create basic query engine with filtering support

### Phase 2: Performance Optimization (2 weeks)
- Add indexing service for frequently queried properties
- Implement result caching with cache invalidation
- Add query optimization and execution planning

### Phase 3: Extensibility (1-2 weeks)  
- Plugin system for view renderers and export strategies
- Security hardening of expression evaluation
- Advanced query features (aggregation, joins)

---

## ADR-002: Expression Evaluation Security Model

**Status**: Proposed  
**Date**: 2025-08-26  
**Requirement IDs**: Security hardening, safe expression evaluation

## Context

Current expression evaluation uses `new Function()` with dynamic code generation, creating potential security vulnerabilities. The evaluation context has access to the full Obsidian API and file system.

## Decision

Implement a sandboxed expression evaluation system:

```typescript
interface IExpressionEvaluator {
  evaluate(expression: string, context: EvaluationContext): Promise<any>;
  validate(expression: string): ValidationResult;
}

class SandboxedExpressionEvaluator implements IExpressionEvaluator {
  private allowedGlobals: Set<string>;
  private functionWhitelist: Set<string>;
  
  constructor() {
    this.allowedGlobals = new Set(['Math', 'Date', 'String', 'Number']);
    this.functionWhitelist = new Set(['date', 'now', 'today', 'iff', 'choice']);
  }
  
  async evaluate(expression: string, context: EvaluationContext): Promise<any> {
    // Parse AST and validate against whitelist
    const ast = this.parseExpression(expression);
    this.validateAST(ast);
    
    // Execute in controlled environment
    return this.executeInSandbox(ast, context);
  }
}
```

### Security Boundaries
1. **AST-based evaluation**: Parse expressions into Abstract Syntax Tree for validation
2. **Function whitelist**: Only allow pre-approved functions and operations
3. **Context isolation**: Limit access to necessary properties only
4. **Resource limits**: Prevent infinite loops and excessive memory usage

## Consequences

### Positive
- **Security**: Eliminates code injection vulnerabilities
- **Reliability**: Prevents expressions from crashing the plugin
- **Predictability**: Clear boundaries on what expressions can do

### Negative
- **Performance**: AST parsing adds overhead compared to direct eval
- **Functionality**: Some advanced expressions may not be possible

---

## ADR-003: Query Engine Architecture

**Status**: Proposed  
**Date**: 2025-08-26  
**Requirement IDs**: Performance optimization, scalability

## Context

Current query implementation scans all files for every query, leading to O(n) performance that doesn't scale with large vaults. No caching or indexing strategy exists.

## Decision

Implement a multi-tier query engine with indexing and caching:

```typescript
interface IIndexService {
  createIndex(property: string): Promise<void>;
  dropIndex(property: string): Promise<void>;
  getIndexedValues(property: string): Promise<Set<any>>;
  findByIndexedValue(property: string, value: any): Promise<string[]>;
}

class QueryEngine implements IQueryEngine {
  constructor(
    private indexService: IIndexService,
    private cacheService: ICacheService
  ) {}

  async execute(query: BaseQuery): Promise<QueryResult> {
    // 1. Check cache for identical query
    const cacheKey = this.generateCacheKey(query);
    const cached = await this.cacheService.get(cacheKey);
    if (cached) return cached;

    // 2. Optimize query using available indexes
    const optimizedQuery = this.optimizeQuery(query);
    
    // 3. Execute optimized query
    const result = await this.executeOptimizedQuery(optimizedQuery);
    
    // 4. Cache result with TTL
    await this.cacheService.set(cacheKey, result, { ttl: 300000 }); // 5 min
    
    return result;
  }

  private optimizeQuery(query: BaseQuery): OptimizedQuery {
    // Use indexes for equality filters
    // Push down filters to reduce dataset early
    // Optimize sort operations using indexed properties
  }
}
```

### Performance Strategies
1. **Property Indexing**: Build indexes for frequently queried properties
2. **Query Result Caching**: Cache expensive query results with invalidation
3. **Filter Pushdown**: Apply filters as early as possible in query pipeline
4. **Incremental Updates**: Only re-process changed files on vault updates

## Consequences

### Positive
- **Performance**: O(log n) query performance for indexed properties
- **Scalability**: Handles large vaults efficiently
- **Responsiveness**: Cached results provide instant responses

### Negative
- **Memory Usage**: Indexes and caches consume additional memory
- **Complexity**: Index management and cache invalidation logic
- **Startup Time**: Initial index building may slow plugin initialization

---

## ADR-004: Integration with ObsidianAPI Abstraction

**Status**: Proposed  
**Date**: 2025-08-26  
**Requirement IDs**: Architecture consistency, plugin integration

## Context

The plugin maintains an ObsidianAPI abstraction layer for all vault operations. The new Bases architecture must integrate seamlessly with this pattern while maintaining the performance benefits of direct API access.

## Decision

Extend the ObsidianAPI abstraction with Bases-specific operations while maintaining the facade pattern:

```typescript
// ObsidianAPI Extensions
interface IObsidianAPI {
  // Existing methods...
  
  // Bases operations
  getBases(): Promise<BaseInfo[]>;
  getBase(path: string): Promise<BaseConfig>;
  createBase(path: string, config: BaseConfig): Promise<void>;
  updateBase(path: string, config: BaseConfig): Promise<void>;
  deleteBase(path: string): Promise<void>;
  
  // Optimized data access for Bases
  getFileMetadataCache(): MetadataCache;
  getFilesByTag(tag: string): TFile[];
  getFilesByFolder(folder: string): TFile[];
  getFileFrontmatter(file: TFile): Record<string, any>;
}

// Dependency Injection Setup
class BasesModule {
  static create(api: IObsidianAPI): BaseService {
    const repository = new ObsidianBaseRepository(api);
    const indexService = new ObsidianIndexService(api);
    const cacheService = new MemoryCacheService();
    const queryEngine = new IndexedQueryEngine(indexService, cacheService);
    
    const viewRenderers = new Map([
      ['table', new TableViewRenderer()],
      ['cards', new CardViewRenderer()],
      ['list', new ListViewRenderer()]
    ]);
    
    const exportStrategies = new Map([
      ['csv', new CSVExportStrategy()],
      ['json', new JSONExportStrategy()],
      ['markdown', new MarkdownExportStrategy()]
    ]);
    
    return new BaseService(repository, queryEngine, viewRenderers, exportStrategies);
  }
}
```

## Consequences

### Positive
- **Consistency**: Maintains established architectural patterns
- **Testability**: Easy to mock ObsidianAPI for testing
- **Performance**: Direct access to Obsidian APIs where needed
- **Flexibility**: Can switch between HTTP and direct API implementations

### Negative
- **Additional Abstraction**: One more layer between Bases logic and Obsidian
- **API Surface**: ObsidianAPI interface grows larger

## Implementation Notes

- Preserve exact method signatures from current implementation for backward compatibility
- Add performance monitoring to identify bottlenecks during migration
- Implement feature flags to enable gradual rollout of new architecture
- Maintain fallback to current implementation if issues arise

---

## Migration Strategy

### Phase 1: Foundation (Week 1-2)
1. Extract core interfaces and domain types
2. Implement repository pattern
3. Create basic service layer
4. Maintain existing API compatibility

### Phase 2: Performance (Week 3-4)
1. Add indexing service
2. Implement caching layer
3. Optimize query execution
4. Add performance metrics

### Phase 3: Extensibility (Week 5-6)
1. Plugin system for views and exports
2. Security hardening
3. Advanced query features
4. Complete testing coverage

### Testing Strategy
- **Unit Tests**: Each service and component in isolation
- **Integration Tests**: End-to-end query workflows
- **Performance Tests**: Benchmark against current implementation
- **Security Tests**: Validate expression evaluation safety

### Risk Mitigation
- **Feature Flags**: Enable gradual rollout
- **Fallback Mechanism**: Revert to current implementation if needed
- **Performance Monitoring**: Track metrics during migration
- **User Feedback**: Beta testing with BRAT users

This architectural redesign addresses all identified issues while maintaining backward compatibility and establishing a foundation for future enhancements.