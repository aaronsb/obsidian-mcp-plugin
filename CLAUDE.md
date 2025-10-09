# Claude Development Guidelines for Obsidian MCP Plugin

## Project Context

This is a hybrid Obsidian plugin that combines:
- **Local REST API functionality** (from coddingtonbear's plugin)
- **Semantic MCP operations** (from aaronsb/obsidian-semantic-mcp)
- **Direct Obsidian API integration** for enhanced performance

The critical architectural pattern is **preserving the ObsidianAPI abstraction layer** while replacing HTTP calls with direct Obsidian plugin API calls. This allows reuse of all existing MCP server logic while gaining performance benefits.

## Code Quality Guidelines

### SOLID Principles Application

- **Single Responsibility**: 
  - `ObsidianAPI` class handles only vault operations abstraction
  - `MCPServer` class handles only MCP protocol operations
  - `HTTPServer` class handles only REST endpoint management
  - Plugin main class handles only Obsidian plugin lifecycle

- **Open/Closed**: 
  - ObsidianAPI interface remains stable for extensions
  - MCP operations extensible through semantic router pattern
  - HTTP endpoints extensible without modifying core logic

- **Liskov Substitution**: 
  - New ObsidianAPI implementation must be drop-in replacement
  - All method signatures and return types must match exactly
  - Error handling behavior must be preserved

- **Interface Segregation**: 
  - Separate interfaces for vault operations, search operations, and workspace operations
  - MCP protocol separated from HTTP REST protocol
  - Plugin settings separated from server configuration

- **Dependency Inversion**: 
  - Depend on Obsidian Plugin API abstractions, not concrete implementations
  - MCP server depends on ObsidianAPI interface, not specific implementation
  - HTTP server depends on operation interfaces, not direct vault access

### Architecture Patterns

#### Critical Abstraction Layer
```typescript
// This interface MUST remain stable
interface IObsidianAPI {
  getFile(path: string): Promise<ObsidianFileResponse>;
  listFiles(directory?: string): Promise<string[]>;
  searchSimple(query: string): Promise<any[]>;
  // ... all existing methods preserved
}

// Implementation changes from HTTP to direct API
class ObsidianAPI implements IObsidianAPI {
  constructor(private app: App) {} // Direct plugin access
  
  async getFile(path: string): Promise<ObsidianFileResponse> {
    // Direct vault access instead of HTTP call
    const file = this.app.vault.getAbstractFileByPath(path);
    // ... implementation
  }
}
```

#### Performance-Critical Patterns
- **Caching Layer**: Implement intelligent caching for frequently accessed files
- **Lazy Loading**: Load heavy operations only when needed
- **Batch Operations**: Combine multiple vault operations where possible
- **Memory Management**: Proper cleanup of file handles and event listeners

#### Error Handling Patterns
```typescript
// Preserve exact error types and messages from HTTP implementation
class VaultError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

// Maintain compatibility with existing error handling
async getFile(path: string): Promise<ObsidianFileResponse> {
  try {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      throw new VaultError(`File not found: ${path}`, 'ENOENT', 404);
    }
    // ... rest of implementation
  } catch (error) {
    // Transform plugin errors to match HTTP API errors
    throw this.transformError(error);
  }
}
```

## Development Workflow

### BRAT Development Release Process

When developing with Obsidian BRAT (Beta Reviewer's Auto-update Tool) for plugin side-loading:

#### Critical Release Workflow
1. **Version Updates**: 
   - **ONLY update `package.json` version** - `sync-version.mjs` automatically syncs to `manifest.json` and `version.ts`
   - DO NOT manually update `manifest.json` - the automation handles this
2. **Commit Strategy**: Use separate commits for:
   - Feature/fix changes 
   - Version bumps
3. **Tag Management**: 
   - NEVER manually create tags before version commits
   - Let GitHub Actions workflow create tags automatically
   - If automation fails, delete existing tags before retry: `git tag -d vX.X.X && git push origin :refs/tags/vX.X.X`
4. **Release Creation**:
   - Workflow checks for tag existence and skips if found
   - Manual release creation: `gh release create vX.X.X --prerelease --title "..." --notes "..." --target main`
   - BRAT users need GitHub releases, not just tags
5. **Automation Issues**: 
   - Workflow may fail if tags exist before version commits
   - Empty commits can trigger workflow: `git commit --allow-empty -m "chore: Trigger release workflow"`
   - Monitor `gh run list` to verify workflow execution

#### BRAT User Experience
- Users install via: `aaronsb/obsidian-mcp-plugin` in BRAT
- BRAT checks GitHub releases for updates automatically  
- Version detection relies on `manifest.json` version field
- Release assets (main.js, manifest.json, styles.css) are auto-generated by workflow

#### Version Naming Convention
- **Major releases**: `X.Y.Z` (e.g., 0.4.4) - NO 'v' prefix
- **Patch releases**: `X.Y.Za`, `X.Y.Zb` (e.g., 0.4.4a, 0.4.4b) - NO 'v' prefix
- **Pre-releases**: All marked as prerelease until stable
- **IMPORTANT**: Obsidian requires release tags WITHOUT 'v' prefix
- **Exploratory releases**: Use letter suffix (a, b, c) for testing new features

### File Organization
```
src/
├── main.ts                 # Plugin entry point
├── obsidian-api.ts        # Direct API implementation (CRITICAL)
├── mcp-server.ts          # MCP protocol handling
├── http-server.ts         # REST API endpoints
├── semantic/              # Reused from obsidian-semantic-mcp
│   ├── router.ts         # Semantic operations router
│   └── operations/       # Individual operation implementations
├── types/                # TypeScript type definitions
└── utils/                # Shared utilities
```

### Testing Strategy
- **Unit Tests**: Each ObsidianAPI method tested against expected interface
- **Integration Tests**: Full MCP and REST workflows tested
- **Performance Tests**: Benchmarking against HTTP-based implementation
- **Compatibility Tests**: Existing client code works without changes

### Build Pipeline
```json
{
  "scripts": {
    "dev": "tsc --watch",
    "build": "tsc && node build-plugin.js",
    "test": "jest",
    "test:performance": "node performance-tests.js",
    "package": "npm run build && npm run test && node package-release.js"
  }
}
```

### Pre-Push Quality Checks

**ALWAYS run these commands before pushing to GitHub:**

```bash
# 1. Build the project to catch TypeScript errors
npm run build

# 2. Run linting to ensure code quality
npm run lint

# 3. Run tests to catch regressions
npm test

# 4. If all pass, commit and push
git add -A && git commit -m "..."
git push origin main
```

**Quick one-liner for all checks:**
```bash
npm run build && npm run lint && npm test && echo "✅ All checks passed!"
```

Note: Even for "simple" changes like updating descriptions or documentation, running these checks ensures no accidental syntax errors or regressions are introduced.

## Plugin-Specific Guidelines

### Obsidian Plugin Lifecycle
```typescript
export default class ObsidianMCPPlugin extends Plugin {
  private obsidianAPI: ObsidianAPI;
  private mcpServer: MCPServer;
  private httpServer: HTTPServer;

  async onload() {
    // 1. Initialize API abstraction layer FIRST
    this.obsidianAPI = new ObsidianAPI(this.app);
    
    // 2. Initialize servers with API dependency
    this.mcpServer = new MCPServer(this.obsidianAPI);
    this.httpServer = new HTTPServer(this.obsidianAPI);
    
    // 3. Start servers
    await this.startServers();
    
    // 4. Register UI components
    this.addSettingTab(new MCPSettingTab(this.app, this));
  }

  async onunload() {
    // Clean shutdown in reverse order
    await this.stopServers();
    this.obsidianAPI.cleanup();
  }
}
```

### Performance Monitoring
```typescript
// Add performance tracking for optimization
class PerformanceTracker {
  static async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await operation();
    const duration = performance.now() - start;
    console.log(`${name}: ${duration.toFixed(2)}ms`);
    return result;
  }
}

// Usage in ObsidianAPI methods
async getFile(path: string): Promise<ObsidianFileResponse> {
  return PerformanceTracker.measure(`getFile:${path}`, async () => {
    // ... implementation
  });
}
```

### Settings Management
```typescript
interface MCPPluginSettings {
  httpEnabled: boolean;
  httpPort: number;
  httpsPort: number;
  enableSSL: boolean;
  debugLogging: boolean;
  performanceMetrics: boolean;
}

const DEFAULT_SETTINGS: MCPPluginSettings = {
  httpEnabled: true,
  httpPort: 27123,
  httpsPort: 27124,
  enableSSL: true,
  debugLogging: false,
  performanceMetrics: false
};
```

## Migration Guidelines

### From HTTP-based Setup
1. **Configuration Migration**: Automatically detect and import REST API plugin settings
2. **Port Compatibility**: Default to same ports as REST API plugin
3. **Feature Parity**: All existing functionality must work identically
4. **Performance Communication**: Clearly communicate performance improvements

### Backward Compatibility Requirements
- **API Responses**: Identical JSON structure and field names
- **Error Codes**: Same HTTP status codes and error messages  
- **Authentication**: Support existing API key mechanisms
- **Headers**: Preserve expected request/response headers

## Documentation Standards

### Code Documentation
```typescript
/**
 * Enhanced file retrieval with direct vault access
 * 
 * @param path - File path relative to vault root
 * @returns Promise resolving to file content and metadata
 * @throws VaultError when file not found or access denied
 * 
 * Performance: ~1-5ms (vs ~50-100ms HTTP implementation)
 * Compatibility: 100% compatible with HTTP API response format
 */
async getFile(path: string): Promise<ObsidianFileResponse> {
  // Implementation...
}
```

### API Documentation
- Maintain compatibility documentation showing HTTP vs Direct API equivalence
- Performance benchmarks for each operation
- Migration examples for common use cases
- Troubleshooting guide for plugin-specific issues

## Success Metrics

### Performance Targets
- **File Operations**: <10ms (vs ~50-100ms HTTP)
- **Search Operations**: <50ms (vs ~100-300ms HTTP)  
- **Directory Listing**: <5ms (vs ~30-60ms HTTP)
- **Memory Usage**: Stable, no leaks during extended operation

### Quality Targets
- **API Compatibility**: 100% backward compatible
- **Test Coverage**: >90% code coverage
- **Error Handling**: Graceful degradation for all failure modes
- **Documentation**: Complete user and developer documentation

### Community Targets
- **BRAT Testing**: 100+ beta installations
- **Feedback Integration**: Active response to community feedback
- **Migration Success**: Smooth transition for existing users
- **Plugin Directory**: Successful submission and approval

## Obsidian Community Plugin Submission

### Maintaining PR During Review Process

While waiting for Obsidian team review (typically 2-6 weeks), keep the PR active:

#### "I'm Not Dead Yet" PR Refresh Procedure

When the PR has been idle and needs to show activity, or when validation checks need to be refreshed:

```bash
# 1. Navigate to the obsidian-releases fork
cd /home/aaron/Projects/app/obsidian-releases

# 2. Fetch latest upstream changes
git fetch upstream

# 3. Hard reset to upstream (clean slate)
git reset --hard upstream/master

# 4. Edit community-plugins.json to add plugin entry at the END
# Add your plugin entry after the LAST plugin in the current list
# (The bot checks that new entries are at the end)

# 5. Commit and push to trigger validation
git add community-plugins.json
git commit -m "chore: Update PR with latest upstream changes"
git push --force origin master
```

**Key Points:**
- Always add your plugin entry at the **END** of `community-plugins.json` (after the current last plugin)
- Do NOT try to preserve your original queue position - the bot now requires entries at the end
- The validation bot triggers automatically within a few minutes after pushing
- This shows the PR is actively maintained and not abandoned
- Can be done periodically (e.g., monthly) to keep PR visible

#### Validation Bot Requirements
- Plugin entry MUST be at the end of the list
- `authorUrl` should be your GitHub profile (not Obsidian website)
- `fundingUrl` should be your sponsors page or removed if not applicable
- All checks must pass before human review begins

#### Benefits of Active Development During Review
- Shows ongoing maintenance and commitment
- Allows continuous improvement based on BRAT user feedback
- Keeps PR current with upstream changes
- Demonstrates plugin stability through multiple versions
- Prevents PR from being auto-closed due to inactivity

#### Release Tag Format
- **Important**: Obsidian requires release tags WITHOUT 'v' prefix
- Use `0.5.4` not `v0.5.4`
- GitHub Actions workflow configured to create correct format

## Important Notes

- **Critical Path**: The ObsidianAPI abstraction layer is the cornerstone of this architecture
- **Performance Focus**: Every operation should demonstrate measurable improvement
- **Compatibility First**: When in doubt, maintain compatibility over new features
- **Plugin Ecosystem**: Consider integration opportunities with other Obsidian plugins
- **Community Feedback**: BRAT testing phase is crucial for identifying issues

---

*This plugin represents the evolution of Obsidian AI integration. Maintain the highest standards as we build the definitive solution for AI-Obsidian connectivity.*