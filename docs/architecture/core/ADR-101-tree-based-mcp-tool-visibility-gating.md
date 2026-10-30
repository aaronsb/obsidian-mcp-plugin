---
status: Draft
date: 2026-03-23
deciders:
  - aaronsb
  - claude
related:
  - ADR-200
---

# ADR-101: Tree-based MCP tool visibility gating

## Context

The plugin currently exposes all registered MCP tools to every connecting agent unconditionally. The existing `VaultSecurityManager` (`src/security/vault-security-manager.ts`) enforces CRUD permissions at runtime — if `permissions.delete` is `false`, a delete call fails with a security error. But agents still *see* the tool in `tools/list`, attempt to call it, and get an error. This is wasteful and confusing for agents that plan tool usage based on enumeration.

More importantly, users have no visibility into what an agent can do. There's no settings UI that shows the full tool surface area or lets users control it. As we add more operation groups (ADR-200), the number of exposed tools grows, and the trust question — "what can this agent actually do to my vault?" — becomes harder to answer.

The security infrastructure already has the right abstractions (`OperationType`, `SecuritySettings.permissions`). What's missing is:

1. **Enumeration-time gating** — tools that are disabled should not appear in MCP `tools/list`
2. **Granular visibility** — control at the individual action level, not just CRUD categories
3. **A settings UI** that makes the full tool surface visible and controllable

## Decision

### Flat permission map with tree UI

Store tool visibility as a flat map in plugin settings:

```typescript
interface MCPPluginSettings {
  // ... existing settings
  toolVisibility: Record<string, boolean>;
  // e.g. "vault.read": true, "vault.delete": false, "tasks.toggle": false
}
```

Keys follow the `operation.action` pattern that already exists in `semantic-tools.ts` (`getActionsForOperation()`). Missing keys default to `true` — backward compatible, existing installs see no change.

### Tree UI in settings panel

The plugin settings panel renders a tree view of all operations and their actions:

```
MCP Tool Visibility
├── [x] vault
│   ├── [x] list
│   ├── [x] read
│   ├── [x] search
│   ├── [x] fragments
│   ├── [x] create
│   ├── [x] update
│   ├── [x] delete
│   ├── [x] move
│   ├── [x] rename
│   ├── [x] copy
│   ├── [x] split
│   ├── [x] combine
│   └── [x] concatenate
├── [x] edit
│   ├── [x] window
│   ├── [x] append
│   ├── [x] patch
│   ├── [x] at_line
│   └── [x] from_buffer
├── [x] view
│   └── ...
├── [x] graph
│   └── ...
├── [x] dataview
│   └── ...
├── [x] bases
│   └── ...
└── [x] system
    └── ...
```

> **Note (2026-10-30, [#326](https://github.com/aaronsb/obsidian-mcp-plugin/issues/326)):** `vault.update` is now the deprecated name of `vault.replace`. The tree shows one `replace` row in its place, and that row governs both names.

**Tri-state cascade behavior** (same pattern as backup include/exclude trees):

| Parent State | Meaning | Visual |
|-------------|---------|--------|
| Checked | All children enabled | Filled checkbox |
| Unchecked | All children disabled | Empty checkbox |
| Indeterminate | Some children enabled, some disabled | Partial/dash checkbox |

- Toggling a parent ON enables all its children
- Toggling a parent OFF disables all its children
- Toggling an individual child updates the parent to reflect aggregate state
- Default on fresh install: all enabled (no behavior change)

### Two enforcement layers

**Layer 1 — Enumeration gating (ergonomic):** During MCP tool registration, check `toolVisibility` for each `operation.action`. Disabled actions are excluded from the `tools/list` response. Agents never see them.

**Layer 2 — Runtime enforcement (security):** The existing `SecureObsidianAPI` validates every call through `VaultSecurityManager`. This remains unchanged. Even if an agent somehow calls a hidden tool (protocol violation, race condition during settings change), the runtime layer blocks it.

The enumeration gate is for agent UX. The runtime gate is for security. Both are needed.

### Mapping to existing security model

Each action maps to an `OperationType` that the security manager already understands:

| OperationType | Example Actions |
|--------------|----------------|
| `READ` | vault.list, vault.read, vault.search, graph.traverse, view.file, dataview.query |
| `CREATE` | vault.create |
| `UPDATE` | vault.update, edit.window, edit.append, edit.patch |
| `DELETE` | vault.delete |
| `MOVE` | vault.move |
| `RENAME` | vault.rename |
| `COPY` | vault.copy |
| `EXECUTE` | view.open_in_obsidian, system.fetch_web |

The granular `toolVisibility` map gives finer control than the CRUD permissions alone. A user might want `vault.update` (edit existing files) but not `vault.delete`. Both are separate toggles in the tree.

> **Note (2026-10-30, [#326](https://github.com/aaronsb/obsidian-mcp-plugin/issues/326)):** "edit existing files" misdescribes `vault.update`: it replaces a file's entire contents. Reading the name as a partial edit led callers to wipe files, so the action was renamed `vault.replace`, and `update` stays as a deprecated alias. The two names share one visibility switch: either `toolVisibility` key set to `false` hides and blocks both, and the `replace` row writes both keys. Partial edits are the `edit` actions in the table above.

### Auto-population

The tree is generated from `getActionsForOperation()` at render time — no hardcoded list in the UI code. When new operations are added (e.g., ADR-200's daily/tasks/templates/properties), they appear in the tree automatically.

## Consequences

### Positive

- Users can see and control exactly what any connecting agent has access to
- Agents get a clean tool enumeration — no wasted calls to tools they can't use
- Strengthens the community plugin submission — reviewers can see granular user control over agent capabilities
- Retroactive — applies to all existing tools, not just new ones
- New tool groups (ADR-200) get visibility control for free by following the existing pattern
- Flat permission map is trivial to check (single hash lookup per tool registration)

### Negative

- Settings panel gets more complex — tree UI with tri-state checkboxes is non-trivial Obsidian UI code
- Users who don't care about granular control see a large tree they don't need to touch (mitigated by all-enabled defaults)
- Settings migration needed for users upgrading — missing `toolVisibility` key defaults to all-enabled, but the settings schema grows

### Neutral

- Does not change the runtime security model — `SecureObsidianAPI` and `VaultSecurityManager` remain as-is
- Tree structure is derived from `semantic-tools.ts` operation/action definitions — no separate source of truth
- Connected agents see changes on next connection, not mid-session (MCP `tools/list` is called once at connection time)

## Alternatives Considered

- **CRUD-level toggles only (current model)**: Just expose the existing `SecuritySettings.permissions` in the UI. Rejected — too coarse. Users can't allow `vault.update` but block `vault.delete` since both are separate CRUD types, but they also can't allow `graph.traverse` while blocking `graph.advanced-traverse` since both are `READ`.
- **Per-tool-group toggles without tree**: A flat list of checkboxes per operation group (vault, edit, graph, etc.). Simpler UI but no action-level granularity. Rejected — doesn't let users fine-tune, and the tree isn't much harder to implement than a flat list.
- **Allowlist approach (opt-in)**: Default all tools to disabled, require explicit enable. Rejected — terrible first-run experience. Plugin installs and nothing works until user enables tools one by one.
- **No UI, config file only**: Store visibility in a YAML/JSON config file. Rejected — Obsidian plugins should be configurable through the settings panel, not by editing files.
