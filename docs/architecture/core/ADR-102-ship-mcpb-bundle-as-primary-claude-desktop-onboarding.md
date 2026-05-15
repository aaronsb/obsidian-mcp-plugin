---
status: Draft
date: 2026-05-15
deciders:
  - aaronsb
  - claude
related:
  - ADR-100
---

# ADR-102: Ship MCPB bundle as primary Claude Desktop onboarding

## Context

ADR-100 simplified the connection-setup surface to two paths: a `claude mcp add` CLI string for Claude Code, and a generic `mcpServers` JSON template for "other clients including Claude Desktop." Both paths still require the user to either run a CLI command or hand-edit a JSON config file and restart Claude Desktop. For non-developer Obsidian users, the JSON path is the steepest part of onboarding — locate the config file, paste the block, get the indentation right, restart.

Anthropic now ships **MCPB** (MCP Bundle, the successor framing for Desktop Extensions) as the supported installer UX in Claude Desktop. An `.mcpb` is a zip-format bundle the user opens with Claude Desktop; Claude Desktop reads the bundle's `manifest.json`, prompts the user for any declared `user_config` fields, and registers the server with zero JSON editing.

Two relevant facts about MCPB as of this writing:

1. **Claude Desktop on macOS and Windows ships its own Node.js runtime** for executing `node`-type bundles. End users do not need Node, npm, or any system runtime installed. The MCPB docs explicitly recommend Node specifically for this friction-reduction reason. UV/Python is also managed by Claude Desktop.
2. **MCPB does not currently support a `remote-http` server type.** Defined server types are `node`, `python`, `binary`, `uv` — all require a local executable entrypoint. There is no manifest shape for "just point Claude Desktop at this URL with these headers."

Fact (2) means this plugin's onboarding cannot be a pure manifest-only bundle. Even though the plugin's MCP server already speaks Streamable HTTP, the bundle still has to expose a local executable that bridges Claude Desktop's stdio launch into the in-Obsidian HTTP endpoint. This is a constraint of MCPB's installer UX, not of MCP transport.

ADR-100 deprecated `mcp-remote` as a *user-facing* config option ("the world that needed it no longer exists"). Using a stdio↔HTTP bridge *inside* an MCPB is a different situation — the user never sees it, installs it, or configures it; it is an implementation detail of the bundle. This ADR carves out that distinction explicitly so the two ADRs do not appear to contradict each other.

## Decision

### 1. Ship an MCPB bundle as the primary Claude Desktop onboarding path

Add a third onboarding option to plugin Settings, ordered ahead of the JSON template. The three onboarding sections become, in priority order:

1. **Claude Desktop (MCPB)** — primary. Link to the latest `.mcpb` release asset, with a "Your values" panel beside it showing the URL and API key (copy buttons) for paste into Claude Desktop's install prompt.
2. **Claude Code (CLI)** — keep the existing `claude mcp add --transport http …` block as-is.
3. **Other MCP clients (JSON)** — demoted from primary. Keep the existing template for power users on clients that lack MCPB support (Cline, Continue, custom integrations).

The `mcpServers` JSON path is not removed. MCPB is added on top.

### 2. Bundle shape: static `node`-type MCPB with a hand-rolled stdio↔HTTP bridge

The bundle is committed to the repo under `mcpb/`:

```
mcpb/
  manifest.json    # node type; user_config: { url, api_key }
  server.js        # ~80-line stdio↔HTTP bridge, no external deps
```

The manifest declares:

- `server.type: "node"` so Claude Desktop's bundled Node.js runs it (no end-user system Node required).
- `user_config` fields: `url` (string, default `http://localhost:3001/mcp`) and `api_key` (sensitive string). Interpolated into `server.env` so `server.js` reads them at startup without needing argv parsing.

`server.js` is a self-contained JSON-RPC↔HTTP relay: read JSON-RPC messages from stdin, POST to the configured `/mcp` endpoint with the `Authorization: Bearer …` header, stream the response (SSE or chunked) back to stdout as JSON-RPC. On session expiry (HTTP 404 with a session id we previously held), the relay surfaces a `-32000` JSON-RPC error so the client (Claude Desktop) re-issues `initialize` — we do not attempt to replay arbitrary user requests across session boundaries because we'd need to also replay state-establishing notifications and that path is fragile. Letting the client own re-init is simpler and matches how Claude Desktop already handles transient sessions.

The bundle is **static**. No per-user values bake into it. The same `.mcpb` works for every user; per-user values flow through Claude Desktop's `user_config` install prompt.

### 3. Hand-rolled bridge over vendored `mcp-remote`

The shim is ~80 lines of plain Node with zero npm dependencies, not a thin wrapper around the `mcp-remote` package. Rationale:

- Bundle stays genuinely tiny — single file, no `node_modules/` tree of vendored deps.
- We don't track `mcp-remote`'s upstream churn (which has had multiple disruptive releases).
- The MCP Streamable HTTP transport spec is small enough that a relay is honest-sized code, reviewable in one sitting.
- Session-fragility concerns that motivated avoiding mcp-remote-style bridges in ADR-100 are largely server-side problems (cf. open issues #128, #147, #150). A client-side relay only needs "session expired → re-init and retry," which is ~10 lines.

### 4. CI publishes the `.mcpb` artifact on change

The existing `release.yml` workflow gains a step that builds the bundle and attaches it to the GitHub release alongside `main.js`, `manifest.json`, and `styles.css`. The build emits both `obsidian-mcp-<version>.mcpb` (versioned, for archival) and `obsidian-mcp.mcpb` (unversioned alias) so the Settings UI and README can link to `releases/latest/download/obsidian-mcp.mcpb` — a stable URL that always resolves to the most recent release without baking the plugin's running version into the link.

Version sync via the existing `sync-version.mjs` script — `manifest.json` inside the bundle stays in lockstep with the plugin's `package.json` version.

### 5. Settings UI: download link plus "your values" panel

The Settings UI for the new primary section shows:

- A heading: "Claude Desktop (MCPB)".
- One sentence: "Download the bundle, open it with Claude Desktop, paste these values in the prompt."
- A link button to the latest `.mcpb` release asset (resolved from the current plugin version's GitHub release).
- A two-line readout: `URL: <http(s)://localhost:<port>/mcp>` and `API key: <key>` with copy buttons on each.

No on-the-fly bundle generation in the plugin for v1 (see Alternatives). The copy-paste of two values is acceptable friction and avoids shipping a zip library inside the Obsidian plugin.

### 6. Single-vault scope; three-tier onboarding by audience

The shipped MCPB is explicitly single-vault. Claude Desktop registers one MCP server per installed bundle, and merging N vaults into one server entry would require aggregating `tools/list` from each upstream, prefixing every tool name to avoid collisions, and re-routing calls on the way back — roughly tripling `server.js` and inflating the tool surface in a way that fights ADR-101 (visibility gating).

Onboarding is therefore tiered by audience:

| Audience | Path |
|---|---|
| Single vault | Drop the shipped `.mcpb` into Claude Desktop |
| Advanced (multi-vault, custom names, scripted setups) | Run the maker script to produce a custom `.mcpb` |
| Other MCP clients (Cline, Continue, etc.) | The existing `mcpServers` JSON block |

The **maker script** (`scripts/make-mcpb.mjs`, planned follow-up) is a small interactive Node CLI using only Node built-ins (`node:readline`, `node:zlib`). It prompts for `name`, `url`, and `api_key`, then emits a custom-named `.mcpb` the user installs in Claude Desktop. No arbitrary vault-count ceiling, no proliferation of release assets, no bridge changes. Multi-vault becomes "run the maker N times" — clean for the audience that wants it without taxing the default path.

All three paths are visible in plugin Settings so users can choose the one that fits.

## Consequences

### Positive

- New users get a one-click install path that does not involve editing JSON config files.
- End users do not need Node, Python, or any runtime installed — Claude Desktop's bundled Node runs the shim.
- The bundle is genuinely static and lives in the repo; review surface is small (one manifest, one ~80-line JS file).
- CI publishing keeps the artifact in sync with releases automatically.
- The JSON and CLI paths remain available for power users and non-Claude-Desktop clients — no functionality is lost.

### Negative

- Reintroduces a stdio↔HTTP bridge as an implementation detail, partially reversing the framing of ADR-100. Mitigated by scope: ADR-100's ban was on user-visible bridge config; the MCPB shim is invisible to users.
- Adds a new file class (`mcpb/`) and a new CI workflow surface that we now have to maintain.
- We own the relay code, including session-expiry reconnect edges. Bugs in the relay become our bugs, not upstream's.
- Two values still need to be copy-pasted across apps (URL and API key) — friction is reduced but not zero.

### Neutral

- Bundle distribution becomes part of the release contract. Versioning, signing, and release-asset hygiene now apply to `.mcpb` alongside `main.js`.
- The `mcp-remote` package is not added as a dependency, vendored or otherwise.
- Localhost-bound HTTP endpoint means MCPB only works when Obsidian and Claude Desktop run on the same machine. Worth noting in the manifest description but not a regression — every existing onboarding path has the same constraint.
- HTTPS mode (self-signed certs on `httpsPort`) works through the shim if `url` is set to the `https://` form; the relay does not need to know.
- The maker script (`scripts/make-mcpb.mjs`) exposes the existence of the bridge to advanced users — they read `mcpb/server.js` when running the script from a clone. This slightly weakens the "bridge is invisible" framing relative to non-advanced users, but the advanced audience is exactly the cohort that would have been writing custom `mcpServers` JSON before MCPB existed, so the abstraction stays intact for the audience that benefits from it.

## Alternatives Considered

- **Wait for MCPB to add a remote-HTTP server type.** Anthropic may eventually add a manifest shape that points at a URL without a local executable. If that lands, the shim deletes and the manifest becomes a few lines. Rejected as the primary plan because there is no signaled timeline; the workaround cost is low enough to ship now.
- **Vendor `mcp-remote` instead of writing our own bridge.** Rejected: pulls a multi-MB dep tree, tracks upstream churn, and the relay work we'd skip is small. Re-evaluate if the hand-rolled relay accumulates non-trivial bugs.
- **Generate a personalized `.mcpb` in-browser from plugin Settings** (zip lib in the plugin clones the static bundle and pre-fills `user_config.defaults` with current port/key). Zero-typing install. Rejected for v1: adds a zip library to the plugin bundle and an extra surface to maintain. Reasonable v2 once real users report on the copy-paste friction.
- **Drop the JSON template entirely.** Rejected: Cline, Continue, custom MCP integrations, and any non-Claude-Desktop client still need the JSON path. The friction was the *primary* placement, not the existence of the path.
- **Stdio-only bundle that spawns a long-lived child process.** Rejected: redundant with the existing HTTP server inside Obsidian; doubles process count and complicates port/session ownership.
- **N-slot multi-vault MCPB** (5 fixed `(url, api_key)` slots in `user_config`, bridge aggregates upstreams into one merged tool namespace). Rejected for v1: tripled bridge complexity, fights ADR-101 by exploding the tool list, and the maker-script path (see Decision §6) serves the same audience without a hardcoded ceiling or bridge changes.
- **Multi-variant publishing** (build and release `obsidian-mcp-vault-a.mcpb`, `…-b.mcpb`, … as separate assets). Rejected in favor of the maker script — same single-vault-per-bundle property, but the user picks names and counts at run time rather than us pre-baking a fixed flavor list into every release.
