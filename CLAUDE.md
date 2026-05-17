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

#### Development vs Release Workflow

**Development (no releases created):**
- Push commits to main freely - no automatic releases triggered
- Test locally with `npm run build`
- Iterate as needed without polluting release history

**Creating a Release (manual trigger):**

Via GitHub UI:
1. Go to **Actions** → **Create Release**
2. Click **Run workflow**
3. Optionally add release notes
4. Click **Run**

Via CLI:
```bash
# Simple release
gh workflow run release.yml

# With release notes
gh workflow run release.yml -f release_notes="Fixed VS Code compatibility, improved search"
```

#### Version Updates
- **ONLY update `package.json` version** - `sync-version.mjs` automatically syncs to `manifest.json` and `version.ts`
- DO NOT manually update `manifest.json` - the automation handles this
- Bump version in `package.json` before triggering a release

#### Tag Management
- Release workflow creates tags automatically (no 'v' prefix)
- If a tag already exists for that version, the release is skipped
- To re-release same version, delete existing tag first:
  ```bash
  git tag -d X.Y.Z && git push origin :refs/tags/X.Y.Z
  ```

#### BRAT User Experience
- Users install via: `aaronsb/obsidian-mcp-plugin` in BRAT
- BRAT checks GitHub releases for updates automatically  
- Version detection relies on `manifest.json` version field
- Release assets (main.js, manifest.json, styles.css) are auto-generated by workflow

#### Version Naming Convention
- **Major releases**: `X.Y.Z` (e.g., 0.4.4) - NO 'v' prefix
- **Patch releases**: `X.Y.Za`, `X.Y.Zb` (e.g., 0.4.4a, 0.4.4b) - NO 'v' prefix
- **Pre-releases**: All releases ship as prereleases by default (`make release-patch` etc.)
- **Promoting to stable**: When a release is bounded and proven, run `make promote` (or `make promote TAG=X.Y.Z`) to flip it from prerelease → stable and mark it as GitHub's "Latest" release. This is also what makes the `/releases/latest/download/<asset>` URL resolve — the MCPB download link in plugin Settings relies on it.
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

### Supply Chain — 7-Day Hold on Upgrades

npm supply-chain attacks have been ticking up — malicious package versions get published, ingested by automation, then discovered/yanked days later. To buy time for community discovery:

**Only land upgrades to versions published more than 7 days ago.**

Practical application:
- Before merging a dependabot PR, check its open date. If it's ≥7 days old, the target version has aged enough — proceed.
- For PRs younger than 7 days, hold them (don't close — they'll age into eligibility on their own).
- If a fresh PR fixes a high-severity vuln we're actively exposed to, the trade-off is real but the answer is usually still "wait." The hypothetical "malicious 3.1.2" risk is broader than the specific CVE in 3.1.1.
- The same rule applies to manual `npm install` / `npm update` invocations — pin to versions older than 7 days, or wait.

Re-run `npm audit` after each merge batch to see what residual exposure remains.

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

## Obsidian Community Plugin Distribution

> **Status:** The plugin is **live in the community directory** as of
> 2026-05-16 (in submittal since 2025-07-04). It is a *maintained, shipped*
> plugin now — not a submission in progress.
>
> **Historical note:** Obsidian previously required a pull request against the
> `obsidianmd/obsidian-releases` repo (editing `community-plugins.json`) plus a
> manual "keep the PR alive" refresh dance. **That process is defunct.**
> Obsidian moved submission and maintenance to the community developer portal
> (community.obsidian.md). Do not recreate the `obsidian-releases` fork
> workflow — there is no PR to maintain anymore.

### Architecture: portal is the source of truth, `community-plugins.json` is a mirror

The developer portal (community.obsidian.md) is now authoritative. A bot
**mirrors** approved plugins from the portal into
`obsidianmd/obsidian-releases/community-plugins.json` (commits titled
`chore: Mirror community plugins and themes`). The desktop app's **in-app
community browser still reads that mirror**, not the portal directly.

Consequence: after a plugin is approved/updated on the portal, there is a
**propagation lag** before it appears in the in-app browser search — the
mirror bot has to run, then the app refreshes its cached list (a restart
helps *only after* the mirror includes you). This is normal, not a bug. The
portal page and its "Add to Obsidian" deep link work immediately. If still
absent from the mirror after ~24h / many mirror commits, that's a real
pipeline miss worth raising with Obsidian — not a repo-side fix.

`make promote` now auto-updates **real users**, not just BRAT testers. The
prerelease → BRAT → promote loop is the safety rail, not ceremony.

### How distribution works now

The portal scans this repo's **GitHub Releases**. For the plugin to be
scanned and distributed:

- There must be a **stable (non-prerelease) "Latest" release** whose tag
  exactly matches the `version` field in `manifest.json`.
- Release tags use **no `v` prefix** — `0.11.21`, not `v0.11.21`. The release
  workflow already produces the correct format.
- `versions.json` must contain a `"<version>": "<minAppVersion>"` entry
  matching `manifest.json` (`make release-*` maintains this).
- Releases ship as **prereleases by default**, and a prerelease is invisible
  to the portal. Run `make promote` to flip the proven release to
  stable + "Latest". This is the step that makes the directory (and the MCPB
  `releases/latest/download/...` link) pick up the new version.

### Validating before publishing

The developer portal offers a **"preview a branch scan"** that accepts a
branch, tag, or commit SHA — use it to confirm a release candidate passes
Obsidian's checks *before* running `make promote`. Treat it as a
validation/dry-run tool: end-user installs and updates still come from the
matching stable release tag's assets, not from a scanned branch.

### Where the listing text comes from

- **Short description** — repo-driven. Single source of truth is
  `package.json`; `sync-version.mjs` propagates it to `manifest.json`; use
  `make set-description DESC='...'` (never hand-edit the JSON). The portal's
  one-liner refreshes on the next scan after release.
- **Long "About"** — *not* in the repo. Obsidian seeded this portal-side
  during the community.obsidian.md migration; it is decoupled from
  `package.json`/`manifest.json` and only editable in the authenticated
  developer portal. Repo edits will **not** change it — update it there.

### Reading the scorecard as free signal — `make scorecard`

The public plugin page (`community.obsidian.md/plugins/semantic-vault-mcp`)
renders an automated **Health** grade and **Review** scan — deterministic
static analysis, not an LLM. It is free signal we can pull without logging in:

```
make scorecard          # prose + freshness delta, for reading
node scripts/scorecard.mjs --json   # one JSON line, for diffing across releases
```

Key facts about this tool:

- **Freshness is not guaranteed.** A *fresh* scan is only triggered from the
  authenticated developer portal. The public page reflects the last release
  Obsidian scanned, so the script reports a `freshness` delta (portal version
  vs `manifest.json`). `STALE` means a logged-in re-scan is still needed.
- **Drift guard.** The findings come from Obsidian's Next.js RSC payload, so
  the parser is coupled to their internal serialization. If the page
  structure changes, the script exits **non-zero with a `SCRAPER DRIFT`
  banner** — that means review `scripts/scorecard.mjs`, *not* that the
  scorecard is clean. The scorecard body itself never gates anything.

### Known accepted review findings

The full submit review passed (0.11.23). Not every finding is a defect —
several are deliberate trade-offs or false positives. Do **not** "fix" these
by reverting the decision behind them; they were analysed and accepted:

- **`.mcpb` additional files** (Releases, Recommendation) — expected. Per
  **ADR-102**, releases intentionally ship the `.mcpb` bundles so
  `releases/latest/download/obsidian-mcp.mcpb` (the plugin Settings download)
  resolves. Clearing it would break ADR-102. Confirmed non-gating.
- **Direct filesystem access** (Behavior, Warning) — `fs` is used in
  `path-validator.ts` (boundary enforcement via `realpathSync` — itself a
  security control) and `certificate-manager.ts` (self-signed TLS certs).
  Load-bearing; cannot remove without dropping HTTPS.
- **Vault enumeration** (Behavior, Recommendation) — `vault.getFiles` etc.
  is the plugin's core purpose (semantic search / graph). By design.
- **Clipboard access** (Behavior, Recommendation) — write-only,
  user-initiated (copy API key / copy buttons). Benign.
- **README "unfilled placeholder text"** (Warning) — **false positive**.
  No real placeholders exist; the heuristic trips on legitimate markdown
  badge/link labels (`[BRAT]`, `[MIT]`, …). Mangling valid markdown to
  appease it is the wrong action — leave it.
- **"… scan not available" disclosures** — neutral. Obsidian's
  malware/dependency/obfuscation scanners did not run; not a failure.

**Dynamic code execution** — the Bases-evaluator `new Function` (the
exploitable vector: arbitrary JS from a synced/shared `.base`) is **removed**
per **ADR-201**, implemented in #180 (PR #185 corpus/baseline, PR #186
expression-eval swap). The evaluator now parses with `expression-eval` (jsep
grammar, no globals) plus a tested `constructor`/`__proto__`/`prototype`/
`this` denylist; a differential corpus proves behavioural parity.

Caveat for future scans: `grep "new Function" main.js` is **not** zero by
design. The residual occurrences are transitive-dependency codegen — ajv
@6.14.0 schema-validator compilation + a library deprecation shim — a
different, library-internal class **not reachable from vault content**. They
were already in 0.11.25's bundle, the release that passed full review with
only the fs Warning, so they were non-gating then. The "Dynamic Code
Execution" Recommendation was attributed to the Bases path specifically;
this clears that path. Whether a heuristic re-scan re-flags the ajv-class
residual is unknown until the next scan (scorecard blind — #183); if it
does, it is the *transitive* class above, not the closed Bases vector.

Actionable findings became issues/PRs: #163/#164/#170 (SSL + attestation,
shipped), #171/#173 (build-dep + CSS, shipped), #174 (js-yaml, shipped),
#180 (sandboxed Bases evaluator, PR #185/#186), #176 (this doc). Scorecard
CI-gate idea: #165.

## Important Notes

- **Critical Path**: The ObsidianAPI abstraction layer is the cornerstone of this architecture
- **Performance Focus**: Every operation should demonstrate measurable improvement
- **Compatibility First**: When in doubt, maintain compatibility over new features
- **Plugin Ecosystem**: Consider integration opportunities with other Obsidian plugins
- **Community Feedback**: BRAT testing phase is crucial for identifying issues

---

*This plugin represents the evolution of Obsidian AI integration. Maintain the highest standards as we build the definitive solution for AI-Obsidian connectivity.*