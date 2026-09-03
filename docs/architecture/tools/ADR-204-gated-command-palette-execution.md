---
status: Accepted
date: 2026-09-02
deciders:
  - aaronsb
  - claude
related:
  - ADR-101
  - ADR-108
  - ADR-200
---

# ADR-204: Gated command-palette execution

## Context

`ObsidianAPI.executeCommand(commandId)` runs any Obsidian command by id through
`app.commands.executeCommandById`. Since 0.12.2 it is wrapped by
`SecureObsidianAPI` and validated as `OperationType.EXECUTE`, which ADR-108
redefined to mean "run a command" (`openFile` moved to `READ`). Read-only
denies `EXECUTE` unconditionally, and #283 removed it from the `safeMode`
preset. The plumbing treats command execution as a distinct, dangerous
permission — and nothing calls it. There is no `execute` in
`getActionsForOperation('system')` and no router case, so the method is
unreachable from the tool surface.

ADR-200 scoped "plugin admin" out of the agent-facing surface. The command
palette is where much of Obsidian's real functionality lives, including every
other plugin's commands, and it is also the single most dangerous thing this
plugin could expose: `app:delete-file`, "Move file to…", and whatever an
installed plugin registers.

Two forks wired it up independently. `Darth-Ginger/obsidian-mcp-plugin` wrote
ADR-204 and ADR-205 in this repo's format and numbering band, extended the
security layers rather than routing around them, and framed ADR-204 as a
question to upstream: if the "admin operations don't belong here" line holds,
mark it Rejected. `kochetkovIT/obsidian-mcp-plugin` added a hardcoded
single-command allowlist. The same concern arrived at twice is reason to decide
rather than leave code that carries security weight without delivering
anything (#286).

## Decision

Expose command execution as a `system.execute` action, off at every layer by
default, behind three independent gates. This is a deliberate carve-out from
ADR-200, narrowed to this one action; ADR-200's reasoning stands for
workspace/tab management, themes, sync, publish, and dev tools.

### Three gates

| Gate | Mechanism | Default |
|---|---|---|
| Enumeration | `toolVisibility['system.execute']` must be explicitly `true` | off |
| Permission | `permissions.execute` in `VaultSecurityManager` (`OperationType.EXECUTE`) | denied in `readOnly` and `safeMode`; allowed in `fullAccess` |
| Allowlist | `commandExecutionAllowlist: string[]` of exact command ids | empty — refuses every command |

A user turns the action on twice — visibility and at least one allowlisted id —
before an agent can run anything. Each gate answers a different question
(discoverable? capability permitted in this mode? which commands, exactly?) at
a different layer (registration, per-call, per-id), so none substitutes for
another.

### Opt-in enumeration inverts ADR-101 for this action

ADR-101's default is "missing key means enabled". `system.execute` is enumerated
only when the key is present and `true`. One shared `OPT_IN_ACTIONS` set is the
source of truth for both the registration gate in `semantic-tools.ts` and the
visibility tree in `main.ts`. The tool handler re-checks it, so a stale or
hidden tool cannot be called into.

### `EXECUTE` is already the dedicated permission

The fork added `OperationType.EXECUTE_COMMAND` to keep `openFile` separate.
ADR-108 achieved that separation by moving `openFile` to `READ` and reserving
`EXECUTE` for command execution, so no new operation type or permission is
needed. `permissions.execute` is the one the presets already deny.

### Allowlist chosen from live command ids

The settings UI populates the allowlist from `app.commands` (a dropdown or
autocomplete over `getCommands()`), never a free-text field. A mistyped id
silently never matches, so the user would believe they allowed something they
did not, with no feedback that the entry is dead. An allowlisted id that later
disappears (plugin disabled, id renamed) simply stops matching.

### Enforcement order for a `system.execute` call

1. Registration: absent an explicit `toolVisibility['system.execute'] === true`,
   the action is not registered and never appears in `tools/list`.
2. Permission: `SecureObsidianAPI.executeCommand` validates
   `OperationType.EXECUTE`; a denied mode throws `SecurityError`.
3. Allowlist: `ObsidianAPI.executeCommand` refuses an id not on the list with a
   structured `COMMAND_NOT_ALLOWED` result, before touching
   `executeCommandById`.

### Dispatch is not completion

`executeCommandById` returns when the callback is invoked. A command that opens
a modal reports `success: true` while a dialog waits on a human the agent cannot
see. Mitigations: snapshot open dialogs (`.modal-container`, `.prompt`) before
dispatch and re-check after a short settle, reporting
`awaitingUserInteraction: true` with a warning when one appeared; raise an
Obsidian `Notice` on every agent-triggered command (setting, default on); state
in the tool description and result type that `success` means dispatched.
Auto-dismissing or auto-confirming a detected dialog is refused outright — an
agent pressing OK on a modal it cannot read could confirm a destructive action.
We detect and report; we never drive.

### Implementation touchpoints

- `src/tools/semantic-tools.ts` — `execute` in the `system` actions, a
  `commandId` parameter, `OPT_IN_ACTIONS`, the handler re-check.
- `src/semantic/router.ts` (or `operations/system.ts` once ADR-202 stage 2
  reaches it) — `case 'execute'` reading `commandId` via `requireParamStr`.
- `src/utils/obsidian-api.ts` — allowlist check and dialog detection in
  `executeCommand`.
- `src/main.ts` — `commandExecutionAllowlist` (default `[]`),
  `notifyOnCommandExecution` (default `true`), the allowlist UI, and the
  `OPT_IN_ACTIONS` default in the visibility tree.

Implementation is tracked separately from this decision.

## Consequences

### Positive

- Upgrading installs gain no new agent capability; every gate ships closed.
- An enabled `system.execute` still cannot reach a command the user never
  listed, so a benign command can be allowed without `app:delete-file`.
- Reuses the enumeration and permission layers ADR-101 and ADR-108 established;
  the allowlist is the command-space analogue of per-path validation.
- Two fork authors get a definite answer, and `Darth-Ginger`'s ADR-204 can be
  rebased onto this one with the `EXECUTE_COMMAND` split dropped.

### Negative

- `system.execute` is the first action to break ADR-101's missing-key-means-
  enabled invariant. Any code reading `toolVisibility` directly must honor
  `OPT_IN_ACTIONS`.
- Three gates are more to explain and test than one toggle.
- Command ids are Obsidian-internal and change across versions and plugin
  state; the allowlist can go stale silently (fail-closed).
- Dialog detection is a DOM heuristic. It catches modals and suggesters, not
  every async UI, and is inert in tests.

### Neutral

- The allowlist is global, like every other setting. Per-session scoping is a
  future ADR if demand appears.
- ADR-205's typed plugin-action adapters (calling a plugin's own API with typed
  arguments, resolving on completion) remain a possible later tier above this
  one. Not decided here.

## Alternatives Considered

- **Never expose it — delete `executeCommand` and its wrapper.** Closes the
  surface and records the decision so it stops being rediscovered. Rejected: the
  capability gap is real, and two forks building it is demand evidence. The
  gates make the exposure narrower than the code that exists today.
- **Typed plugin actions instead (ADR-205 direction).** Better completion
  semantics, typed arguments, no modal trap. Deferred, not rejected: only
  scaffolding exists, and it layers on top of gated dispatch rather than
  replacing it.
- **Leave as is.** Unreachable but present. Rejected: security weight with no
  delivery, and the least defensible resting place.
- **One "enable command execution" toggle.** Rejected: implicitly trusts every
  command, the blanket default ADR-101 declined.
- **Honor ADR-101's default for this action.** Rejected: missing-key-means-
  enabled is a footgun for arbitrary command execution.
- **Free-text allowlist.** Rejected: a typo becomes a dead entry the user
  believes is live.
- **Add `OperationType.EXECUTE_COMMAND`.** Rejected: ADR-108 already split
  `openFile` off `EXECUTE`; a second type would duplicate a distinction that
  exists.
