# Obsidian MCP Plugin

![GitHub stars](https://img.shields.io/github/stars/aaronsb/obsidian-mcp-plugin?style=social)
![GitHub forks](https://img.shields.io/github/forks/aaronsb/obsidian-mcp-plugin?style=social)
![Downloads](https://img.shields.io/github/downloads/aaronsb/obsidian-mcp-plugin/total?color=blue)
![Latest Release](https://img.shields.io/github/v/release/aaronsb/obsidian-mcp-plugin?include_prereleases&label=version)
![License](https://img.shields.io/github/license/aaronsb/obsidian-mcp-plugin)

**Give AI semantic agency over your knowledge graph**

This plugin connects your Obsidian vault to AI assistants through MCP (Model Context Protocol), giving them the ability to understand and navigate your notes as a connected knowledge graph, not just isolated files. Through semantic hints and graph traversal, AI gains the agency to explore concepts, follow connections, and synthesize information across your entire vault.

**MCP (Model Context Protocol)** is the open standard that lets AI assistants interact with external tools and data sources. This plugin works with any MCP-compatible client including:
- Claude Desktop (Anthropic)
- Claude Code/Continue.dev (VS Code)
- Any platform that supports local MCP servers

<!-- STATS:START -->
<!-- Last updated: 2025-11-17 -->

### 🌟 Community Engagement
| Metric | Count |
|--------|-------|
| ⭐ Stars | 146 |
| 🍴 Forks | 10 |
| 👀 Watchers | 146 |
| 👁️ Views (14 days) | 0 (0 unique) |
| 📥 Clones (14 days) | 0 (0 unique) |

### 📦 Release Downloads
| Version | Downloads |
|---------|-----------|
| **Total All Versions** | **11477** |
| Latest (0.10.1) | 297 |
<!-- STATS:END -->

## Why Semantic MCP?

Traditional file access gives AI a narrow view - one document at a time. This plugin transforms that into **semantic agency**:

- **Graph Navigation**: AI follows links between notes, understanding relationships and context
- **Concept Discovery**: Semantic search finds related ideas across your vault
- **Contextual Awareness**: AI understands where information lives in your knowledge structure
- **Intelligent Synthesis**: Combine fragments from multiple notes to answer complex questions

## Quick Start

**Prerequisites:** You need an MCP-compatible AI client like Claude Desktop, Claude Code, or Continue.dev.

### 1. Install the Plugin

**Via Obsidian Community Plugins** (coming soon)
- Open Settings → Community plugins
- Search for "Semantic MCP"
- Install and enable

**Via BRAT** (for beta testing)
- Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
- Add beta plugin: `aaronsb/obsidian-mcp-plugin`

### 2. Configure Your AI Client

**For Claude Desktop / Claude Code**
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```

**With Authentication** (if enabled in plugin settings)
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://localhost:3443/mcp",
        "--header",
        "Authorization:${AUTH}"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "AUTH": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 3. Start Using

Once connected, simply chat with your AI assistant about your notes! For example:
- "What are my recent thoughts on project X?"
- "Find connections between my psychology and philosophy notes"
- "Summarize my meeting notes from this week"
- "Create a new note linking my ideas about Y"

Your AI assistant now has these capabilities:
- Navigate your vault's link structure
- Search across all notes semantically
- Read, edit, and create notes
- Analyze your knowledge graph
- Work with Dataview queries (if installed)
- Manage Obsidian Bases (database views)

## Core Tools

The plugin provides 8 semantic tool groups that give AI comprehensive vault access:

| Tool | Purpose | Key Actions |
|------|---------|-------------|
| **📁 vault** | File operations | list, read, create, search, move, split, combine |
| **✏️ edit** | Content modification | window editing, append, patch sections |
| **👁️ view** | Content display | view files, windows, active note |
| **🕸️ graph** | Link navigation | traverse, find paths, analyze connections |
| **💡 workflow** | Contextual hints | suggest next actions based on state |
| **📊 dataview** | Query notes | Execute DQL queries (if installed) |
| **🗃️ bases** | Database views | Query and export Bases (if available) |
| **ℹ️ system** | Vault info | Server status, commands, web fetch |

## Documentation

Detailed documentation for each tool and feature:

- [📁 Vault Operations](docs/tools/vault.md) - File management and search
- [✏️ Edit Operations](docs/tools/edit.md) - Content modification strategies  
- [🕸️ Graph Navigation](docs/tools/graph.md) - Link traversal and analysis
- [📊 Dataview Integration](docs/tools/dataview.md) - Query language support
- [🔐 Security & Authentication](docs/security.md) - API keys and permissions
- [🔧 Configuration](docs/configuration.md) - Server settings and options
- [❓ Troubleshooting](docs/troubleshooting.md) - Common issues and solutions

## The Semantic Advantage

This plugin doesn't just give AI access to files - it provides **semantic understanding**:

### Example: Research Assistant
```
User: "Summarize my research on machine learning optimization"

AI uses semantic tools to:
1. Search for notes with ML optimization concepts
2. Traverse graph to find related papers and techniques  
3. Follow backlinks to discover applications
4. Synthesize findings from multiple connected notes
```

### Example: Knowledge Explorer
```
User: "What connections exist between my notes on philosophy and cognitive science?"

AI uses graph tools to:
1. Find notes tagged with both topics
2. Analyze shared concepts via graph traversal
3. Identify bridge notes that connect domains
4. Map the conceptual overlap
```

## Features

### Semantic Search
- Advanced query operators: `tag:`, `path:`, `content:`
- Regular expressions and phrase matching
- Relevance ranking and snippet extraction

### Graph Intelligence
- Multi-hop traversal with depth control
- Backlink and forward-link analysis
- Path finding between concepts
- Tag-based navigation

### Content Operations
- Fuzzy text matching for edits
- Structure-aware modifications (headings, blocks)
- Batch operations (split, combine, move)
- Template support

### Integration
- Dataview query execution
- Bases database operations
- Web content fetching
- Read-only mode for safety

## Plugin Settings

Access settings via: Settings → Community plugins → Semantic MCP

Key configuration options:
- **Server Ports**: HTTP (3001) and HTTPS (3443)
- **Authentication**: API key protection
- **Security**: Path validation and permissions
- **Performance**: Connection pooling and caching

## Support

- **Issues**: [GitHub Issues](https://github.com/aaronsb/obsidian-mcp-plugin/issues)
- **Discussions**: [GitHub Discussions](https://github.com/aaronsb/obsidian-mcp-plugin/discussions)
- **Sponsor**: [GitHub Sponsors](https://github.com/sponsors/aaronsb)

## License

MIT
