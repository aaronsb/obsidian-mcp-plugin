# Semantic Notes Vault MCP

![GitHub stars](https://img.shields.io/github/stars/aaronsb/obsidian-mcp-plugin?style=social)
![GitHub forks](https://img.shields.io/github/forks/aaronsb/obsidian-mcp-plugin?style=social)
![Downloads](https://img.shields.io/github/downloads/aaronsb/obsidian-mcp-plugin/total?color=blue)
![Latest Release](https://img.shields.io/github/v/release/aaronsb/obsidian-mcp-plugin?include_prereleases&label=version)
![License](https://img.shields.io/github/license/aaronsb/obsidian-mcp-plugin)

📦 **[Available in the Obsidian Community Plugin directory →](https://community.obsidian.md/plugins/semantic-vault-mcp)**

**Read, write, search, and traverse your Obsidian vault from any AI assistant — through an MCP server that runs _inside_ Obsidian.**

No external Node process to launch, no separate REST-API plugin to bridge through: the server *is* the plugin. Setup is a drag-and-drop — drop the `.mcpb` bundle onto Claude Desktop, paste your key, done.

It exposes **8 powerful tools** — each a whole family of operations, not a single call (the `vault` tool alone handles 13: list, read, create, search, move, split, combine, and more) — with first-class **Dataview** and **Bases** support plus graph traversal across links, tags, and backlinks. And every operation respects the permissions *you* set — a read-only mode, per-operation controls, and path allow/block lists — so the AI only ever does what you've allowed, not unrestricted run of your vault.

**Works with any MCP-compatible client** — Claude Desktop, Claude Code, Cline, Continue.dev, and anything that speaks local MCP.

> **New to MCP?** The [Model Context Protocol](https://modelcontextprotocol.io) is the open standard that lets AI assistants interact with external tools and data. You don't need to understand it to use this — the [Quick Start](#quick-start) is three steps.

## Quick Start

**Prerequisites:** an MCP-compatible AI client like Claude Desktop, Claude Code, or Continue.dev.

> ## 📦 ──drag──▶ 🤖💬
> **Download the `.mcpb` bundle from the plugin's config page → drag it onto Claude Desktop → paste your key. Done.**

For most people that's the entire setup. The numbered steps below spell it out, then cover other MCP clients.

### 1. Install the Plugin

**Via Obsidian Community Plugins**
- Open Settings → Community plugins → Browse
- Search for "Semantic Notes Vault MCP"
- Install and enable — or install straight from the [plugin listing](https://community.obsidian.md/plugins/semantic-vault-mcp)

**Via BRAT** (for beta testing)
- Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
- Add beta plugin: `aaronsb/obsidian-mcp-plugin`

### 2. Configure Your AI Client

Three onboarding paths, ordered by audience. All three are also shown in the plugin's Settings tab with copy-ready values.

**📦 → 🤖 Claude Desktop — one-click `.mcpb` install (recommended)**

Download `obsidian-mcp-<version>.mcpb` — either from the plugin's **Settings** tab (button right on the config page) or the [latest release](https://github.com/aaronsb/obsidian-mcp-plugin/releases/latest) — then either drag it onto the Claude Desktop window or double-click it. Claude Desktop opens an install dialog with two fields — paste the URL and API key shown in the plugin's Settings tab, hit Save, and you're done.

> *Cross-platform note:* `.mcpb` files install via Claude Desktop's bundled handler. If double-click doesn't trigger Claude on your system, drag the file onto Claude Desktop's window instead, or right-click → "Open with…" and pick Claude Desktop (then "always open with" if your OS asks). Behavior varies by platform: macOS usually auto-associates, Windows may need a one-time association, Linux varies by desktop environment.

**Claude Code** — one command (copy the ready-made version with your API key from the plugin's Settings tab):

```bash
claude mcp add --transport http obsidian http://localhost:3001/mcp --header "Authorization: Bearer YOUR_API_KEY"
```

For HTTPS, use `https://localhost:3443/mcp` instead — see [Trusting the self-signed certificate](#trusting-the-self-signed-certificate) below. **Claude Code runs on Bun, which does not read the macOS system keychain**, so you will need to set `NODE_EXTRA_CA_CERTS`.

**Other MCP clients (Cline, Continue, custom integrations, multi-vault setups)**

Add an entry to the client's MCP config file — one entry per vault if you run multiple Obsidian instances on different ports:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "transport": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        }
      }
    }
  }
}
```

**Advanced: custom `.mcpb` per vault**

For multi-vault setups that want one-click install per vault, clone this repo and run the maker:

```bash
node scripts/make-mcpb.mjs
# Prompts for display name, URL, and API key
# Outputs obsidian-mcp-<slug>.mcpb with everything pre-filled
```

Drop the resulting bundle into Claude Desktop and click Install — no fields to type.

### Trusting the self-signed certificate

The plugin's HTTPS server uses a self-signed certificate auto-generated on first start and stored under `.obsidian/plugins/semantic-vault-mcp/certificates/default.crt` inside your vault. MCP clients reject self-signed certificates by default, so you need to explicitly trust it before connecting over HTTPS. Pick the method that matches your client runtime.

**macOS Keychain** (for clients that use the system trust store — Claude Desktop, browser-based tools, Node with `--use-system-ca`):

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

**`NODE_EXTRA_CA_CERTS`** (required for Claude Code and other Bun-based runtimes):

Bun does **not** consult the macOS system keychain for TLS trust, so trusting the certificate via Keychain Access alone has no effect — this is almost always the real reason an HTTPS connection from Claude Code fails. Bun only honors certificates listed in `NODE_EXTRA_CA_CERTS`:

```bash
# Point directly at the plugin cert, or append it to an existing CA bundle:
export NODE_EXTRA_CA_CERTS=/path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt

# Propagate to GUI apps launched from the macOS dock (including Claude Code):
launchctl setenv NODE_EXTRA_CA_CERTS /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

Re-run these whenever the plugin regenerates its certificate (e.g. after the 1-year validity expires).

> **Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0`.** It disables TLS verification process-wide — for *every* HTTPS connection the client makes, not just this plugin — and masks legitimate certificate problems (expired, revoked, tampered). Trust the certificate explicitly instead.

### 3. Start Using

Once connected, simply chat with your AI assistant about your notes! For example:
- "What are my recent thoughts on project X?"
- "Find connections between my psychology and philosophy notes"
- "Summarize my meeting notes from this week"
- "Create a new note linking my ideas about Y"

Your AI assistant now has these capabilities:
- Navigate your vault's link structure
- Search and rank across all notes
- Read, edit, and create notes
- Analyze your knowledge graph
- Work with Dataview queries (if installed)
- Manage Obsidian Bases (database views)

## Why It's Different

Traditional file access gives AI a narrow view — one document at a time. This plugin gives it the whole connected picture:

- **Graph Navigation**: AI follows links between notes, understanding relationships and context
- **Concept Discovery**: Search and graph traversal surface related ideas across your vault
- **Contextual Awareness**: AI understands where information lives in your knowledge structure
- **Intelligent Synthesis**: Combine fragments from multiple notes to answer complex questions

## Core Tools

The plugin provides 8 powerful tools that give AI comprehensive vault access — each one a family of related operations, all subject to the permissions you set:

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

## In Practice

This plugin doesn't just give AI access to files — it lets AI work across your vault as a connected whole:

### Example: Research Assistant
```
User: "Summarize my research on machine learning optimization"

AI uses these tools to:
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

### Full-Text Search
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

Access settings via: Settings → Community plugins → Semantic Notes Vault MCP

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

[MIT](LICENSE)
