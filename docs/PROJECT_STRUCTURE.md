# Project Structure

```
obsidian-mcp-plugin/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── workflows/
│   │   ├── test.yml          # CI/CD tests
│   │   └── security.yml      # Security scanning
│   └── pull_request_template.md
│
├── src/
│   ├── main.ts               # Plugin entry point
│   ├── mcp-server.ts         # MCP HTTP server
│   ├── semantic/             # Semantic operations
│   │   └── router.ts         # Operation routing
│   ├── tools/                # MCP tool implementations
│   ├── utils/                # Utility functions
│   │   ├── obsidian-api.ts   # Vault operations
│   │   ├── session-manager.ts # Session handling
│   │   └── connection-pool.ts # Connection management
│   └── types/                # TypeScript definitions
│
├── github-issues/            # Security audit findings
│   ├── 01-authentication-vulnerability.md
│   ├── 02-path-traversal-vulnerability.md
│   ├── 03-input-validation-missing.md
│   ├── 04-insecure-session-management.md
│   ├── 05-solid-principles-violations.md
│   ├── 06-large-vault-scalability.md
│   └── README.md
│
├── tests/                    # Test files
├── docs/                     # Documentation
│
├── .gitignore
├── CHANGELOG.md             # Version history
├── CONTRIBUTING.md          # Contribution guidelines
├── LICENSE                  # MIT License
├── README.md               # Main documentation
├── SECURITY.md             # Security policy
├── manifest.json           # Obsidian plugin manifest
├── package.json            # Node.js dependencies
├── tsconfig.json           # TypeScript config
└── versions.json           # Version compatibility
```

## Key Directories

### `/src`
Core plugin code. Main entry point is `main.ts`.

### `/src/semantic`
Handles semantic routing for MCP operations. The router maps operations to actual implementations.

### `/src/utils`
Shared utilities including the ObsidianAPI abstraction layer and session management.

### `/.github`
GitHub-specific files including issue templates and automated workflows.

### `/github-issues`
Detailed security audit findings ready to be posted as GitHub issues.

## Configuration Files

- `manifest.json` - Obsidian plugin metadata
- `package.json` - Node dependencies and scripts
- `tsconfig.json` - TypeScript compiler settings
- `versions.json` - Obsidian version compatibility

## Development Files

- `CLAUDE.md` - Project-specific instructions for AI assistants
- `.claude/CLAUDE.md` - User's global AI instructions