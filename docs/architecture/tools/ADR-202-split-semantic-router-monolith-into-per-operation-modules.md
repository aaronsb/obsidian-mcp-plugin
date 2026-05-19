---
status: Accepted
date: 2026-05-18
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-202: Split semantic router monolith into per-operation modules

## Context

`src/semantic/router.ts` had grown to **2,228 lines** — ~2.8× the project's
800-line "split before adding more" quality threshold (#199). It was already
oversized before the May 2026 contributor-PR work; every new operation or
action grew it further (the #139 per-file-lock change had to be threaded into
an already-2,200-line file because there was no smaller home).

`SemanticRouter.executeOperation()` is a clean dispatcher to per-operation
handlers (`executeVaultOperation`, `executeEditOperation`, …). These are
natural module seams and already match the `src/semantic/operations/` layout
CLAUDE.md prescribes. `executeVaultOperation` plus its vault-private helpers
is by far the largest single unit (~the bulk of the file).

CLAUDE.md calls the `IObsidianAPI`/router abstraction the architectural
cornerstone, so this is a deliberate, mechanical-but-large refactor that must
be staged and behaviour-preserving, not bundled into a feature PR.

## Decision

Introduce a **`RouterContext` interface** (the dependency surface a router
exposes to extracted handlers) and extract per-operation handlers into
`src/semantic/operations/*.ts` as free functions
`executeXOperation(ctx: RouterContext, action, params)`. `SemanticRouter
implements RouterContext` and passes **itself** as the context, so shared
state and mutations propagate without getter/setter indirection.
`executeOperation` becomes a thin dispatch (`return
executeVaultOperation(this, action, params)`).

**This PR is the first, focused stage** (the issue's own recommendation —
"`executeVaultOperation` is the biggest single win and could be extracted
first in isolation"):

- New `operations/router-context.ts` — minimal `RouterContext` (the four
  members the vault path touches: `api`, `app?`, `fragmentRetriever`,
  `validator`); grows as further handlers are extracted.
- New `operations/shared.ts` — `Params`, `SearchResultItem`, and the
  `paramStr/paramNum/paramBool` helpers, previously router-private and needed
  by every handler.
- New `operations/vault.ts` — `executeVaultOperation` + its live helpers
  (`splitContent`, `sortFiles`, `copyFile`, `copyDirectoryRecursive`),
  mechanically transformed (`this.` → `ctx.`; the TypeScript compiler is the
  safety net — a missed rewrite is a compile error in a free function).
- The router's relevant fields (`api`, `app`, `fragmentRetriever`,
  `validator`) are made `public readonly` to satisfy `RouterContext`. This
  widens visibility on the cornerstone class; the interface is the explicit
  boundary and the cost is accepted.
- **Pre-existing dead code removed.** Extraction surfaced a fully
  unreachable file-search subtree — `combineSearchResults`, `isDirectory`,
  `performFileBasedSearch`, `indexVaultFiles`, and transitively
  `getSearchWorkflowHints`, `extractContext`, `getFileType` — private methods
  with **zero call sites** in the original `router.ts` or anywhere in
  `src/`/`tests/` (eslint's `no-unused-vars` does not flag unused class
  methods, which is why they survived). Removing unreachable code is
  behaviour-preserving by definition; ~290 lines eliminated outright.

Result: `router.ts` **2,228 → 988 lines**; `vault.ts` 948; `make check`
green with the **exact** pre-existing warning baseline (0 errors, 5
unrelated `prefer-active-doc` warnings) and **235/235** tests unchanged.

### Scope and staging

`router.ts` at 988 lines is **not yet under the 800-line acceptance**;
`vault.ts` at 948 is itself over 800. Both are accepted for this stage:

- Faithful to the issue's "extract vault first in isolation" guidance and
  to keeping one PR mechanically reviewable.
- `vault.ts` maps exactly to the `operations/vault.ts` seam CLAUDE.md
  prescribes; `executeVaultOperation` is inherently the largest operation.
  Sub-splitting vault *by action* is a possible later refinement, not this
  ADR's seam.
- #199 stays open with a follow-up: extract `edit`/`view`/`graph`/
  `system`/`bases` the same way (router → thin dispatcher, < ~300 lines;
  each `operations/*.ts` independently testable). The acceptance closes when
  that lands.

## Consequences

### Positive

- Removes the single worst quality-threshold violation in the codebase and
  ~290 lines of provably dead code.
- Establishes the reusable `RouterContext` + free-function pattern; each
  subsequent handler extraction is now mechanical and low-risk.
- `vault.ts` is independently testable without constructing the whole
  router.
- No behaviour change: `tsc` proves the mechanical rewrite; the full suite
  is unchanged at 235/235.

### Negative

- Widens visibility of four router fields from `private` to `public
  readonly` (mitigated: `RouterContext` is the declared, narrow boundary;
  `readonly` prevents external mutation).
- Two-stage (or more) resolution of #199 — the acceptance is not met by
  this PR alone. Accepted in exchange for reviewability and the issue's
  explicit "not bundled / extract vault first" guidance.

### Neutral

- `operations/shared.ts` now owns param helpers; `router.ts` and future
  operation modules import them rather than each redefining.
- Follow-up PRs extend `RouterContext` with the members the remaining
  handlers touch (e.g. `context`, `tokenManager`, graph tools).

## Alternatives Considered

- **One PR extracting all seven handlers.** Rejected: same volume of change
  but far worse reviewability ("trust me" vs. a readable mechanical diff);
  contradicts the issue's "not bundled / first in isolation" guidance.
- **Mixin / prototype assignment to split the class across files.**
  Rejected: fights TypeScript's type system, loses the compile-time safety
  net that makes the `this.`→`ctx.` rewrite verifiable.
- **Thin delegating wrapper methods that call module functions.** Rejected:
  adds lines back to `router.ts`, working against the threshold goal for no
  structural benefit.
- **Carry the dead code into `vault.ts` unchanged.** Rejected: it would add
  ~290 lines and 13 lint warnings to a fresh module; the code is provably
  unreachable so deletion is behaviour-preserving and the honest result of
  the move.
