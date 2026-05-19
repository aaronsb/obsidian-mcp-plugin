---
status: Accepted
date: 2026-05-18
deciders:
  - aaronsb
  - claude
related: [104]
---

# ADR-105: Remove dormant worker-offload path (partial reversal of ADR-104)

## Context

[ADR-104](ADR-104-offload-cpu-bound-semantic-operations-to-worker-threads-and-deconflict-the-sse-route.md)
made two coupled decisions: (1) ratify and extend a worker-thread pool to
offload CPU-bound `vault`/`graph`/`edit` operations off Obsidian's main
thread, and (2) deconflict the shadowed `GET /mcp` SSE route. The second half
shipped in #196 and works. This ADR concerns only the first half.

Code review of #196 (issue #197) established, and a re-verification against
current `main` confirmed, that **the worker-offload path has never executed a
single request since it was introduced** (undocumented, v0.5.8b commit
`22742bd`):

- `ConnectionPool.shouldUseWorker` gated on action-level strings
  (`tool.vault.search`, `tool.graph.search-traverse`, …) matched with
  `String.includes`.
- The pool's `'process'` dispatch builds method strings at the **operation**
  level — `mcp-server.ts` does `request.method.replace('tool.', '')` against
  a `tool.<operation>` form, i.e. `tool.vault`, `tool.edit`, `tool.graph`.
- `"tool.vault".includes("tool.vault.search")` is `false`. The gate never
  matched for any operation, so `processWithWorker` was never called and the
  `WorkerManager`/`semantic-worker` path was dead code on every release.
- Independently, the build emitted the worker to
  `dist/workers/workers/semantic-worker.js` (double-nested, because
  `tsc src/workers/*.ts` infers `rootDir=src/` from cross-directory imports)
  while `WorkerManager` resolved `dist/workers/semantic-worker.js` — so even
  had the gate matched, the `Worker` constructor would have failed to load
  the script.

There are no field reports of CPU/event-loop starvation attributable to the
absence of offloading (the symptom ADR-104 cited, #125, was addressed by the
SSE-route fix and the two-row Levenshtein change, both shipped in #196).
"Fixing forward" — repairing the gate and the path — was evaluated and
rejected: it would ship a previously-untested concurrency path whose
prefetch→compute→write shape **widens the existing silent parallel-edit race
(#139)** with a new TOCTOU window, in exchange for a performance benefit
nobody has been observed to need.

## Decision

**Remove the worker-offload path entirely.** Delete
`src/workers/semantic-worker.ts`, `src/utils/worker-manager.ts`,
`build-worker.js`, the `build:worker` npm script, and the `node
build-worker.js` step from the `build` script. Strip the worker wiring from
`ConnectionPool` (`workerManager`, `workerScript`, `shouldUseWorker`,
`processWithWorker`, the worker-event listeners, `terminateAll`) and the
dead `prepareWorkerContext` / `workerScript` option from `mcp-server.ts`.

`ConnectionPool` is **retained** as a main-thread bounded request queue.
Scope note: review of #197 established that the `ConnectionPool` request
pipeline itself was *also* dormant — `submitRequest`/`submitPriorityRequest`
are never called; the live request path is `MCPServerPool` → SDK
`setRequestHandler` → `tool.handler()` directly. This ADR deliberately
**limits scope to the worker-offload path** (the ADR-104 subject); whether
to also remove the unused `ConnectionPool`/`MCPServerPool` scaffolding is
left to a separate decision, not bundled here. `processQueue` now
unconditionally emits `'process'`, the path the (dormant) queue already
took.

This is a **partial reversal of ADR-104**: the worker-offload decision is
withdrawn; the SSE-route deconfliction decision is untouched and remains in
effect. ADR-104 keeps `status: Accepted` and carries a banner pointing here;
its status is *not* flipped to `Superseded`, which would falsely imply the
still-governing SSE half was reversed too.

## Consequences

### Positive

- Removes ~600 lines of verified-dead code and an entire build step.
- Eliminates a latent TOCTOU race-widener before it could ship (#197),
  keeping #139's fix surface to the single main-thread write path.
- Removes the broken `dist/workers/workers` path-resolution trap from the
  build output, one fewer thing to mis-diagnose in future scans.
- Behaviour-preserving by construction: the deleted path never ran, so no
  runtime behaviour changes for any client.

### Negative

- Forecloses worker-thread offloading as the answer if event-loop
  starvation is *later* reported under heavy load. Mitigation: it would be
  reintroduced deliberately, correctly wired and tested, behind its own ADR
  — strictly better than resurrecting code that never worked.

### Neutral

- `ConnectionPool`/`PriorityConnectionPool`/`MCPServerPool` remain; their
  contracts are unchanged from the caller's perspective (the worker branch
  was unreachable, so callers never observed it).
- ADR-104's banner and `related` linkage make the partial-reversal
  relationship discoverable from either direction.

## Alternatives Considered

- **Fix forward (repair the gate + path, port `from_buffer`/recovery-buffer
  correctly, add a CAS).** Rejected: ships an untested concurrency path that
  widens #139's race, for an unproven performance need. (See #197 Blocker 2 /
  TOCTOU analysis.)
- **Leave the dead code in place, close #197 as won't-fix.** Rejected:
  dead code that *looks* load-bearing is a standing mis-diagnosis hazard
  (scorecard scans, future contributors) and keeps a broken build step.
- **Flip ADR-104 to `Superseded`.** Rejected: it would falsely flag the
  shipped, still-governing SSE-route deconfliction as reversed. Partial
  supersession is expressed via banner + this ADR instead.
