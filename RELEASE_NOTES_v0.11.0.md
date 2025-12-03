# Release v0.11.0

## 🎉 Major Changes

### Granular Vault Tools Refactor
The monolithic `vault` tool has been refactored into individual, granular MCP tools for fine-grained permission control:

- **New Tools**: `list`, `read`, `create`, `delete`, `move`, `rename`, `copy`, `split`, `combine`, `concatenate`, `search`, `fragments`
- **Benefit**: AI clients (like Claude Desktop) can now manage permissions for each operation separately
- **Security**: Enhanced security posture with granular permission management

### Search Functionality Improvements
Fixed and enhanced the search tool to match Obsidian's native search behavior:

- **Fixed**: `file:` and `path:` operators now support quoted strings
- **Fixed**: Combined operators now work correctly
- **Improved**: Better handling of complex search queries

### Verbosity Reduction
Reduced response size and improved clarity:

- **Removed**: `workflow` objects from responses
- **Fixed**: Patch append operations no longer add extra newlines when patching headings and lists
- **Improved**: Cleaner, more concise responses for AI agents

## 🐛 Bug Fixes

- Fixed patch append adding extra newlines to headings
- Fixed patch append breaking list continuity
- Fixed search operators not handling quoted strings
- Fixed combined search operators failing

## 🧪 Testing

- Added comprehensive tests for patch operations
- Added tests for verbosity reduction
- Added tests for granular vault tools
- All 110 tests passing

## 📝 Breaking Changes

> [!WARNING]
> The `vault` tool has been split into multiple granular tools. If you have existing integrations or permission configurations, you may need to update them to use the new tool names.

## 🔧 Technical Details

**Merged Branches:**
- `refactor/granular-vault-tools` - Granular tool refactor
- `fix/search-improvements` - Search functionality fixes
- `reduceVerbocity` - Response verbosity reduction

**Files Changed:**
- Configuration: `package.json`, `manifest.json`
- Tests: `tests/patch-operations.test.ts`, `tests/recursive-copy.test.ts`
- Multiple source files across the refactored tools

---

**Full Changelog**: [v0.10.2...v0.11.0](https://github.com/aaronsb/obsidian-mcp-plugin/compare/v0.10.2...v0.11.0)
