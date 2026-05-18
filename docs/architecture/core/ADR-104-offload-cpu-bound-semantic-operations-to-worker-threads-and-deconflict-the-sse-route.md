---
status: Draft
date: 2026-05-18
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-104: Offload CPU-bound semantic operations to worker threads and deconflict the SSE route

## Context

Issue #125 reports two distinct stability failures in the MCP server, both
observed under sustained real-world use (heavy Gemini CLI / agent traffic):

1. **Request timeouts from a blocked event loop.** CPU-intensive work —
   principally the fuzzy-match search inside `edit.window` — runs on the
   plugin's main thread. Obsidian is single-threaded; while a large fuzzy
   match runs, the event loop cannot service the MCP transport's heartbeat,
   so the client declares the request timed out and may enter a reconnect
   loop. The work eventually completes, but the client has already given up.

2. **SSE reconnection loops from a shadowed route.** A debug endpoint
   registered as `GET /mcp` (returning a JSON "endpoint active" blurb)
   intercepts the client's `GET /mcp` SSE-stream establishment, so the
   streaming channel never opens and the client retries indefinitely.

A worker-thread pool **already exists** in the codebase — introduced
undocumented in v0.5.8b (`feat: Add worker threads for true concurrent
processing`, commit `22742bd`): `src/utils/worker-manager.ts`,
`connection-pool.ts`, `mcp-server-pool.ts`, and `src/workers/semantic-worker.ts`.
It offloads `vault` and `graph` operations but **not** `edit` — so the one
operation class most responsible for blocking the event loop (fuzzy
matching) still runs on the main thread. The architecture was never recorded
in an ADR, so this decision serves double duty: ratify the existing
worker-thread baseline, and decide the #125 extension on top of it.

PR #126 (external contributor, `djsplice` — also the reporter of #125)
implements the extension and the route fix. This ADR is the architectural
gate for landing that work: the worker pool is core server architecture
(Core domain), and extending what runs off-thread plus changing transport
route registration are decisions that should be recorded, not slipped in via
a contributor merge.

This is a different failure class from the idle-session-drop cluster
(#128 / #190 — `compat-init` cannot re-initialize the SDK 1.29 transport).
#190 explicitly lists #147/#150 as the declined attempts; #126 is not among
them and is not obsoleted by #190. The two fixes are complementary and live
at different layers (CPU scheduling + route registration here; session
re-initialization there).

## Decision

**Ratify the existing worker-thread pool as the sanctioned execution model
for CPU-bound semantic operations, and extend it to cover `edit`
operations.** Fuzzy matching for `edit.window` is dispatched to the worker
pool via the existing `WorkerManager`/`semantic-worker` path, with the
target file's contents passed in worker `context` so the worker is
self-contained and the main thread is freed for the duration of the match.
The worker uses a memory-efficient two-row Levenshtein distance rather than
a full matrix.

**Deconflict the MCP route registration.** The debug endpoint moves from
`GET /mcp` to `GET /mcp-info`, and the protocol endpoint is registered with
`app.all('/mcp', …)` so a single handler serves both `POST` (messages) and
`GET` (SSE stream) without a shadowing route in between.

Boundaries of this decision:

- **Scope is CPU-bound semantic work**, not all work. I/O-bound vault
  operations that are already fast on the main thread are not forced
  off-thread for its own sake.
- **The 30 s worker task timeout is retained** as the backstop — offloading
  reduces event-loop starvation but does not license unbounded work.
- **The worker-script path resolution** (`dist/workers/...`) is an
  implementation detail of the build output layout, not an architectural
  commitment; it must be verified against the actual bundled layout during
  review (PR #126 carries a `workers/workers` path adjustment that needs
  confirmation, not blind acceptance).

## Consequences

### Positive

- The event loop is no longer starved by `edit.window` fuzzy matching;
  the MCP heartbeat is serviced during large edits, so the timeout →
  reconnect-loop failure in #125 (1) is removed at its cause rather than
  papered with a longer client timeout.
- The SSE route shadowing in #125 (2) is eliminated; `GET /mcp` reaches the
  transport, and debug info remains available at the explicit `/mcp-info`.
- The previously-undocumented worker architecture now has a recorded
  rationale and a defined scope, so future "should this run in a worker?"
  questions have a reference instead of being re-litigated per PR.
- Two-row Levenshtein bounds worker memory for large files.

### Negative

- Worker dispatch adds serialization overhead and a context round-trip
  (file contents shipped into the worker). For small files the off-thread
  path can be marginally slower wall-clock than inline — accepted, because
  the failure being fixed is tail-latency / event-loop starvation, not mean
  latency.
- More moving parts in the edit path (worker lifecycle, the 30 s timeout
  boundary, context marshalling) — more surface to reason about when an
  `edit` misbehaves.
- The build must reliably emit `semantic-worker.js` at the path the runtime
  resolves; a layout mismatch is now a load-bearing failure mode (see the
  path-resolution caveat above).

### Neutral

- Ratifies existing code (the v0.5.8b pool) rather than introducing a new
  subsystem; the net-new surface is the `edit` case plus the route change.
- Independent of, and complementary to, the #128/#190 idle-session work —
  different layer, different failure class.
- `app.all('/mcp')` consolidates method handling; any future per-method
  divergence (e.g. method-specific middleware) must branch inside the
  single handler rather than via separate route registrations.

## Alternatives Considered

- **Raise the client/request timeout.** Rejected — masks the symptom; the
  event loop is still blocked, other in-flight requests still stall, and the
  reconnect loop returns under heavier load. Treats tail latency as a
  constant to tolerate rather than a defect to remove.
- **Keep fuzzy matching on the main thread but chunk it / yield
  periodically.** Rejected — cooperative yielding inside a hot
  string-distance loop is fragile, easy to regress, and still competes with
  every other main-thread consumer (Obsidian UI, vault events). The worker
  pool already exists and is the cleaner boundary.
- **Move the debug endpoint behind a query param on `GET /mcp` instead of a
  separate path.** Rejected — still couples debug output to the SSE
  establishment path and risks subtle precedence bugs; a distinct
  `/mcp-info` path is unambiguous.
- **Decline #126 and fold the work into the #128/#190 session effort.**
  Rejected — they are different failure classes at different layers;
  coupling them delays a proven, isolated stability fix behind an open
  investigation.
