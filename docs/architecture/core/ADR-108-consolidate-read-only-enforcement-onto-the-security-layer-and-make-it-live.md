---
status: Draft
date: 2026-07-29
deciders:
  - aaronsb
related:
  - ADR-101
---

# ADR-108: Consolidate read-only enforcement onto the security layer and make it live

## Context

Read-only mode is enforced in **two** places that derive their state from
different sources and disagree with each other:

1. **Tool layer** — `src/tools/semantic-tools.ts:142` reads
   `plugin.settings.readOnlyMode` **live** on every dispatch, but only for
   `operation === 'vault'`.
2. **Security layer** — `src/mcp-server.ts:132` picks
   `VaultSecurityManager.presets.readOnly()` **once, in the server
   constructor**, and hands it to `SecureObsidianAPI`.

The split produces a state neither author intended. Toggling read-only on a
running server arms the live tool-layer check immediately while the security
layer keeps the permissive ruleset it was constructed with, so `vault.create` is
refused while `edit.append` writes to disk. Disabling read-only has the mirror
problem: writes stay blocked until the next restart.

The settings toggle claims otherwise. `src/main.ts:1100` shows
*"🔒 Read-only mode enabled. All write operations are blocked."* while the debug
line beside it concedes *"Server restart required for activation."* A user who
believes the notice gets a containment boundary that is not in effect.

This was reported externally as an `edit`-bypasses-read-only vulnerability. The
reporter attributed it to the tool-layer guard's `operation === 'vault'`
narrowness. That narrowness is real, but it is not sufficient to explain the
write: every `edit` action routes through a method wrapped by the security layer
(`appendToFile`, `patchVaultFile`, `updateFile`), and those correctly reject when
the layer holds the read-only preset. The write landed because the layer was
holding a **stale** ruleset. The finding reproduces only without a restart.

A related structural problem sits behind ADR-108's sibling fix (#276): three
write paths reached the vault without passing through the security layer at all.
The cause there was a **missing method on the abstraction** — the layer had no
move/rename method, so calling code reached around it to `app.fileManager`.
Widening the tool-layer guard into a general write-action registry was
considered and rejected during that work: adding a second policy engine is what
created this class of bug, and a registry would have to be kept in sync with
every new action forever.

The constraint that shapes this decision: **one enforcement path, not two.**

## Decision

**Enforcement lives solely in `VaultSecurityManager.validateOperation`, and its
permission state is read live rather than snapshotted.**

1. **Make the permission source live.** `isOperationAllowed` consults a
   read-only predicate injected from the plugin settings before consulting the
   settings snapshot. When read-only is on, `READ` is permitted and everything
   else is denied — which is exactly `presets.readOnly()`, evaluated per call
   instead of per construction.

2. **Pull, not push.** Session-scoped `SecureObsidianAPI` instances are created
   inside `MCPServerPool.createPooledServer` and captured in closures; the
   `servers` map holds `PooledServer`, not the API. There is no registry of live
   API instances to iterate, so a "broadcast the new settings on toggle" design
   has nothing to broadcast to and would silently miss instances — the same
   fail-open shape as the original bug. A live predicate is correct by
   construction: new and existing sessions consult one source.

3. **The baseline ruleset must stay permissive.** The predicate can only *add*
   denial; it cannot grant. That asymmetry is deliberate — a user who configures
   restrictive permissions should not have them loosened by a read-only toggle —
   but it makes a restrictive baseline a one-way door. `mcp-server.ts` previously
   installed `presets.readOnly()` when the server booted with read-only on, so
   toggling read-only *off* left every permission false until the next restart:
   the OFF direction of the very bug this ADR set out to fix, surviving in a file
   the first draft of this decision did not touch. The branch is removed and the
   single permissive `BASELINE_SECURITY_SETTINGS` is exported so a test can pin
   the invariant. Path validation and `.mcpignore` blocking are unaffected —
   those are not permissions.

4. **Demote the tool-layer guard to presentation.** It stops deciding anything.
   `PERMISSION_DENIED` from the security layer is relabelled to
   `READ_ONLY_MODE` when read-only is on, preserving the clearer error without a
   second gate. Removing enforcement here is the point: the duplicate is the
   defect.

5. **Correct the user-facing copy.** The toggle notice stops asserting an
   immediate guarantee it cannot make — now it can, so the notice becomes true.
   The setting description stops enumerating an incomplete list
   ("create, update, delete, move, rename") and states the actual rule: every
   operation that changes the vault is blocked, reads and opens still work, and
   it takes effect immediately.

6. **Split `openFile` off `EXECUTE`.** `EXECUTE` originally meant `openFile`
   alone, and read-only denied it, so read-only blocked opening a note — which
   mutates nothing. Wrapping `executeCommand` (needed, since the command palette
   reaches "Delete current file") put a genuinely dangerous operation behind the
   same permission, forcing a choice between blocking a harmless open and
   permitting arbitrary commands under read-only. `openFile` is now charged as
   `READ` and works under read-only; `EXECUTE` covers `executeCommand` and stays
   denied. Path validation still applies to `openFile`, so it cannot probe outside
   the vault or open an excluded file.

## Consequences

### Positive

- The switch behaves as a switch. Toggling read-only takes effect immediately in
  both directions, matching what the UI has always claimed.
- One place to reason about. A future operation is enforced by the gate it
  already flows through; there is no second list to remember to update.
- Restart-order bugs in this area are structurally closed for the *permission*
  state: there is no read-only snapshot left to go stale. This claim was too broad
  in the first draft — the predicate's add-only asymmetry meant a restrictive
  *baseline* still had to be removed separately (decision 3) before the OFF
  direction worked. The remaining snapshot is the non-read-only settings, which
  the toggle does not touch.
- The notice stops lying, which is the part of the reported finding that
  actually harmed users.

### Negative

- A per-call predicate is marginally more work than reading a cached boolean.
  Negligible against the vault I/O and path validation in the same call, but it
  is no longer a pure field read.
- `validateOperation` gains a dependency on plugin settings, coupling the
  security layer to the plugin shape a little more tightly. Mitigated by
  injecting a predicate rather than the plugin object.
- Demoting the tool-layer guard removes a redundant check. Redundancy has value
  against a bug in the remaining gate, so the gate's test coverage has to carry
  more weight — see below.

### Neutral

- Requires the enforcement tests added in #276 to keep a mode that arms **only**
  the security layer. Those tests originally passed on vulnerable code because
  the legacy tool-layer guard satisfied them; a `securityLayer` invoke mode was
  added so the layer is exercised directly. That mode must exist **before** this
  demotion lands, or the demotion removes the thing that was masking the gap
  and nothing notices.
- `presets.readOnly()` remains for explicit/API use; it is no longer the
  mechanism by which the settings toggle takes effect, and is no longer installed
  at server construction.
- A restrictive baseline still cannot be loosened at runtime, by design. Anything
  that wants runtime-adjustable permissions beyond read-only needs its own
  predicate rather than a snapshot.

## Alternatives Considered

- **Widen the tool-layer guard into a fail-closed write-action registry.**
  Rejected: it entrenches two enforcement paths, which is the cause of this
  defect, and requires perpetual sync with every new action. Explicitly ruled
  out by the maintainer during #276.
- **Push updated settings to every live API instance on toggle.** Rejected: the
  session APIs are closure-captured with no registry to iterate, so the push
  would be partial and fail open — the original bug's shape. It also leaves the
  snapshot in place, so the class of bug survives.
- **Keep restart-required and only fix the wording** (notice says "takes effect
  after restart"). Rejected: honest, but a toggle that needs a restart
  contradicts what a switch means to a user, and this is a containment control
  where the gap between belief and reality is the harm. Cheapest option, and the
  fallback if liveness proves unstable.
- **Recreate the server on toggle.** Rejected: correct but disproportionate —
  it drops every live MCP session to change one boolean.
