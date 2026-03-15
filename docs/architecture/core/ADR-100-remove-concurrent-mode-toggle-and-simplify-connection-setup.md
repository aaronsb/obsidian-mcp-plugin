---
status: Draft
date: 2026-03-14
deciders:
  - aaronsb
related: []
---

# ADR-100: Remove concurrent mode toggle and simplify connection setup

## Context

The plugin currently has a "concurrent sessions for agent swarms" toggle in settings, with a separate code path for single-server mode (`MCPServer`) vs pooled mode (`MCPServerPool`). This toggle was added when no MCP client supported multiple concurrent connections over HTTP — Claude Desktop required `mcp-remote` as a stdio bridge, and agent swarms were experimental.

The MCP ecosystem has since matured:

- **Claude Code** natively supports Streamable HTTP transport (`claude mcp add --transport http`)
- **Claude Desktop** now supports direct HTTP transport in its config
- **Cline, Continue, and other clients** support HTTP transport
- The MCP SDK itself handles session multiplexing at the transport layer

The dual code path (concurrent vs non-concurrent) adds maintenance burden with no user benefit. The pool handles single-client connections gracefully — it's just a pool of size 1.

The settings UI also presents 4 connection options (Claude Code command, direct HTTP, mcp-remote, Windows mcp-remote workaround), which confuses users. The `mcp-remote` option was a bridge for clients that couldn't speak HTTP — that world no longer exists.

Additionally, the direct HTTP config template embeds credentials in the URL (`obsidian:key@localhost`), which is non-standard and some clients may not parse correctly.

## Decision

### 1. Always run in concurrent/pooled mode

Remove the `enableConcurrentSessions` setting and the single-server code path. The `MCPServerPool` becomes the only mode. Remove `maxConcurrentConnections` from the settings UI (keep it as a sensible default, e.g. 32, or move to an advanced/hidden setting).

### 2. Simplify connection templates to two options

**Claude Code** — a ready-to-copy `claude mcp add` command:
```
claude mcp add --transport http obsidian http://localhost:3001/mcp --header "Authorization: Bearer <key>"
```

**Other MCP clients** — a single JSON template using standard header-based auth:
```json
{
  "mcpServers": {
    "Vault": {
      "transport": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "headers": {
          "Authorization": "Bearer <key>"
        }
      }
    }
  }
}
```

### 3. Remove deprecated connection options

- Drop `mcp-remote` option (Option 2) — clients speak HTTP natively now
- Drop Windows `mcp-remote` workaround (Option 2a) — no longer needed
- Drop URL-embedded credentials format — use standard `Authorization` header

### 4. Update documentation

- Update README connection setup section
- Update plugin settings UI descriptions
- Remove references to "concurrent mode" and "agent swarms" toggle
- Update CLAUDE.md if it references the concurrent setting

## Consequences

### Positive

- Simpler settings UI — fewer toggles, fewer "which option do I pick?" moments
- One code path to maintain instead of two
- Standard auth pattern (Bearer header) works with all clients
- Reduced confusion for new users setting up the plugin

### Negative

- Users on very old MCP clients that only support stdio may lose a documented path (mcp-remote). They can still figure it out from the JSON template, but it's no longer hand-held.
- Breaking change for anyone who has `enableConcurrentSessions: false` in their saved settings — migration should handle this gracefully (ignore the field).

### Neutral

- The `MCPServerPool` default of 32 max connections remains reasonable for all use cases
- The API key mechanism is unchanged — only the config template format changes
- HTTPS/SSL configuration is unaffected

## Alternatives Considered

- **Keep the toggle but default to on**: Still maintains two code paths. Adds complexity for zero benefit since the pool handles single connections fine.
- **Keep mcp-remote as a third option**: Adds UI clutter for a shrinking audience. Users who need it can adapt the JSON template.
- **Remove auth entirely and rely on localhost trust**: Rejected — some users expose the port via tunnels or run in multi-user environments. Auth should remain but with a simpler config format.
