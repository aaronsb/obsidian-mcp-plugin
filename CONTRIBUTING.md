# Contributing to Obsidian MCP Plugin

Thanks for your interest in contributing! Since this is a small project, we keep things simple.

## Quick Start

1. **Found a bug?** Open an issue with:
   - What you expected to happen
   - What actually happened
   - Steps to reproduce

2. **Want to fix something?**
   - Fork the repo
   - Make your changes
   - Test locally with BRAT
   - Submit a PR with a clear description

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/obsidian-mcp-plugin.git
cd obsidian-mcp-plugin

# Install dependencies
npm install

# Build and watch
npm run dev

# Run tests
npm test
```

## Code Style

- TypeScript with strict mode
- Follow existing patterns in the codebase
- Keep security in mind (see SECURITY.md)
- Add tests for new features

## Testing with BRAT

1. Build the plugin: `npm run build`
2. In Obsidian, install BRAT plugin
3. Add your local build: `YOUR_USERNAME/obsidian-mcp-plugin`
4. Test thoroughly before submitting PR

## Commit Messages

Keep them clear and descriptive:

- `fix: Prevent path traversal in file operations`
- `feat: Add rate limiting to API endpoints`
- `docs: Update security guidelines`
- `refactor: Extract validation logic to separate module`

## Current Focus Areas

Check our [GitHub Issues](https://github.com/aaronsb/obsidian-mcp-plugin/issues) for:

- 🔴 Security vulnerabilities (highest priority)
- 🟠 Input validation improvements
- 🟡 Code quality refactoring

## Questions?

Open an issue or discussion - we're here to help!
