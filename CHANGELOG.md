# Changelog

All notable changes to the Obsidian MCP Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- 🔴 CRITICAL: Identified authentication vulnerability - no API key validation ([#9](https://github.com/aaronsb/obsidian-mcp-plugin/issues/9))
- 🔴 CRITICAL: Identified path traversal vulnerability in file operations ([#10](https://github.com/aaronsb/obsidian-mcp-plugin/issues/10))
- 🟠 HIGH: Identified missing input validation across all operations ([#11](https://github.com/aaronsb/obsidian-mcp-plugin/issues/11))
- 🟠 HIGH: Identified insecure session management implementation ([#12](https://github.com/aaronsb/obsidian-mcp-plugin/issues/12))

### Added
- Security policy (SECURITY.md) for vulnerability reporting
- Contributing guidelines (CONTRIBUTING.md)
- Issue templates for bug reports and feature requests
- GitHub labels for security, priority, and technical debt tracking
- Comprehensive security audit documentation

### Changed
- Project structure improved with proper open-source documentation
- Search: `tag:` now also matches frontmatter tags as well as tags in content

## [0.5.14] - 2025-01-11

### Added
- **Advanced File Operations**: New vault actions for complex file manipulation
  - `split` - Split files into multiple parts with 4 strategies:
    - `heading` - Split by markdown heading levels
    - `delimiter` - Split by custom delimiter string
    - `lines` - Split by line count per file
    - `size` - Split by character count with smart word boundaries
  - `combine` - Merge multiple files into one with options:
    - Custom separators between files
    - Optional filename headers
    - Sort files before combining (by name/size/date)
  - `concatenate` - Simple two-file joining (append/prepend/new)
  - All operations include semantic workflow hints
  - Smart content preservation in split operations

## [0.5.13] - 2025-01-10

### Added
- **File Management Operations**: New vault actions for organizing files
  - `move` - Move files to new locations with automatic link updates
  - `rename` - Rename files in place with automatic link updates
  - `copy` - Create copies of files with optional overwrite
  - All operations include semantic workflow hints for next actions
  - Uses native Obsidian file manager when available for link preservation
  - Fallback to copy/delete for environments without direct API access

## [0.5.12] - 2025-01-07

### Changed
- **Enhanced Tool Descriptions**: Improved clarity for AI agents
  - Added single emoji per operation for visual categorization (📁✏️👁️💡ℹ️🕸️)
  - Clarified action descriptions with specific use cases
  - Refined parameter descriptions to avoid ambiguity
  - Better disambiguation between similar actions (e.g., window vs file)
  - Balanced approach: ~17% character increase for significant clarity gains

### Design Philosophy
- Single emoji per operation category to aid visual scanning
- No emojis in parameters to avoid style contamination in user content
- Trust the semantic hinting layer for workflow guidance
- Focus on what makes each action unique

## [0.5.11] - 2025-07-07

### Added
- **Structured Patch Targeting**: Precise document modifications
  - Target headings with `targetType: 'heading'` and nested paths like "Section::Subsection"
  - Target blocks with `targetType: 'block'` using block IDs (^blockId)
  - Target frontmatter with `targetType: 'frontmatter'` for field updates
  - All modes support append, prepend, and replace operations

### Technical Implementation
- New helper methods: `patchHeading()`, `patchBlock()`, `patchFrontmatter()`
- Intelligent section boundary detection for heading operations
- Automatic frontmatter creation if none exists
- Maintains exact whitespace and formatting of untargeted content
- 7 comprehensive unit tests covering all patch modes

### Fixed
- Patch operations now properly handle structured targeting as originally designed
- Resolved disconnect between semantic API design and implementation

## [0.5.10] - 2025-07-07

### Fixed
- **Patch Operation Silent Failures**: Resolved parameter mismatch issue
  - Patch operations were returning success without modifying files
  - Fixed parameter passing between semantic router and API layer
  - The router now correctly maps `oldText`/`newText` to `old_text`/`new_text`
  - Resolves issue #4 where patch operations failed silently

### Changed
- Updated semantic router to properly pass patch parameters
- Maintained backward compatibility with existing patch operations

## [0.5.9] - 2025-07-05

### Added
- **True Concurrent Sessions Support**: Multiple AI agents can work simultaneously without blocking
  - Session-isolated MCP server pool architecture
  - Each session gets its own complete MCP server instance
  - Automatic session management with 1-hour timeout
  - Session reuse for reconnecting clients
- **Session Monitoring**: New `obsidian://session-info` resource shows active sessions
- **Enhanced Documentation**: 
  - mcp-remote configuration for Claude Desktop
  - Dynamic resource count in plugin settings
  - Both direct HTTP and mcp-remote options documented

### Fixed
- Concurrent sessions now truly run in parallel without interference
- Graph traversal operations no longer block other sessions
- Session context properly isolated between connections
- Plugin settings UI shows all available resources

### Changed
- Moved concurrency isolation to a higher architectural level
- MCP SDK remains unaware of concurrency (simpler, cleaner design)
- Transparent request routing to session-specific servers

## [0.5.8c] - 2025-07-05

### Added
- Session-isolated MCP server pool architecture for true concurrent processing
- MCPServerPool class to manage multiple isolated server instances
- Server pool statistics in session-info resource

### Fixed
- Concurrent sessions now truly run in parallel without interference
- Graph traversal operations no longer block other sessions
- Session context properly isolated between connections

### Changed
- Moved concurrency isolation to a higher architectural level
- Each session gets its own complete MCP server instance
- MCP SDK remains unaware of concurrency (simpler, cleaner design)
- Transparent request routing to session-specific servers

## [0.5.8b] - 2025-07-05

### Added
- Worker thread infrastructure for CPU-intensive operations
- WorkerManager for session-based worker lifecycle
- Semantic worker for processing search and graph operations

### Changed
- Updated build process to compile worker scripts
- Operations can be offloaded to worker threads

### Fixed
- Attempted to resolve concurrent session blocking (partial fix)

## [0.5.8a] - 2025-07-05

### Added
- **Concurrent Sessions Support**: Multiple AI agents can now work simultaneously
  - Session-based connection pooling with up to 32 concurrent operations
  - Each MCP client gets a unique session ID for isolation
  - Session tracking and automatic cleanup after 1 hour of inactivity
  - New `obsidian://session-info` resource for monitoring active sessions
  
- **Worker Thread Infrastructure**: Foundation for parallel processing
  - Worker manager for handling CPU-intensive operations
  - Prepared infrastructure for offloading search and graph traversal
  - Non-blocking architecture to keep Obsidian UI responsive
  
- **Enhanced Connection Pool**: Improved request handling
  - Queue-based processing with configurable limits
  - Session-aware request routing
  - Automatic resource cleanup and error recovery

### Changed
- Updated MCP server to support session headers (`Mcp-Session-Id`)
- Enhanced debug logging to include session information
- Improved request processing pipeline for better concurrency

### Technical Details
- Added `ConnectionPool` class for managing concurrent requests
- Added `SessionManager` for tracking and expiring sessions
- Added `WorkerManager` for future worker thread operations
- Prepared semantic worker script for parallel processing

## Previous Versions

See git history for changes before v0.5.8a