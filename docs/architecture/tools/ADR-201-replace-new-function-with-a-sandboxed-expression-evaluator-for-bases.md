---
status: Accepted
date: 2026-05-16
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-201: Replace new Function with a sandboxed expression evaluator for Bases

## Context

`src/utils/expression-evaluator.ts:44` evaluates Bases filter and formula
expressions with:

```js
const func = new Function('context', `with (context) { return ${expression}; }`);
```

The `expression` string comes from `.base` files read out of the vault
(`bases-api.ts` → `app.vault.read`), reached via the core Bases filter path
(`bases-api.ts:264`) and formula path (`formula-engine.ts:33`).

`.base` files are ordinary vault files: they are **synced and shareable**
(Obsidian Sync, git, shared/team vaults, downloaded templates). Therefore
opening or querying a Base authored by anyone else **silently executes
arbitrary JavaScript in Obsidian's Electron renderer**, with full Node and
Obsidian API reach (the `with (context)` form plus the global scope
`new Function` closes over). This is not "the user running their own code" —
it is a remote-ish code-execution vector through a file type users routinely
exchange.

Obsidian's automated review flagged this as a Recommendation (non-gating);
the plugin passed review and is live on `0.11.23`. The motivation here is
**the security reality, not the lint**: a live community plugin should not
execute arbitrary code from a syncable file.

## Decision

Replace `new Function` with a **vetted, maintained, no-`eval` expression
library** that has its own parser and **no access to JS globals or the
`Function` constructor** (e.g. an `expr-eval` / `filtrex`-class evaluator).
The Bases formula/filter grammar is small and bounded (property access,
comparisons, boolean logic, a known function set), so a restricted evaluator
preserves 100% of current functionality.

Two hard constraints on the implementation (which lands as a follow-up issue,
not this ADR):

1. **Do not hand-roll a parser/AST interpreter.** A bespoke evaluator trades
   one risk (`new Function`) for subtler parser-injection and
   correctness bugs we would then own forever. Adopt an audited library
   whose safety property is explicit (no global/`Function` access).
2. **Differential test corpus is mandatory.** Build a corpus of
   representative real `.base` filters and formulas with expected results,
   and assert the new evaluator returns identical results to the existing
   `new Function` path before the swap. This is the robust
   pattern-exploration mechanism the change requires, and it doubles as the
   Bases test coverage gap already tracked in #174.

This ADR records the decision. Implementation is a separate tracked issue;
that implementation — not this ADR — is what finally clears the scanner
Recommendation.

## Consequences

### Positive

- Removes a real arbitrary-code-execution vector reachable through a
  synced/shared `.base` file in a live community plugin.
- Permanently clears the Obsidian "Dynamic Code Execution" finding.
- The differential corpus gives Bases a regression safety net it lacks today.

### Negative

- Implementation effort: integrate the library, map the grammar, build the
  corpus.
- Formula-compatibility risk — some currently-working expression may rely on
  JS behavior the restricted evaluator does not reproduce. The differential
  corpus is the mitigation; genuinely incompatible constructs must be
  documented as breaking and called out in release notes.
- A new runtime dependency to vet and keep current (supply-chain surface),
  versus the current zero-dependency `new Function`.

### Neutral

- Overlaps with #174 (js-yaml → yaml) — both touch the Bases subsystem and
  both want the same `.base` test fixtures; sequencing them together is
  sensible.
- Library choice itself is deferred to the implementation issue (evaluate
  candidates against the corpus before committing).

## Alternatives Considered

- **Accept and document the `new Function` use.** Rejected: the review
  passing makes this *permissible*, but it leaves arbitrary code execution
  reachable via a syncable/shareable file in a shipped plugin. Documenting a
  hole is not closing it.
- **Hand-roll our own AST parser + interpreter.** Rejected: "I'll write my
  own expression evaluator, but with blackjack and hookers" — replacing a
  known risk with a bespoke parser introduces its own injection and
  correctness failure modes that we would then maintain indefinitely. An
  audited library with an explicit no-globals safety property is strictly
  better than a parser we debug ourselves.
- **Heavyweight sandbox (iframe / Worker / VM realm).** Rejected: overkill
  for a bounded expression language; materially more complexity and
  lifecycle/perf cost than a grammar-restricted evaluator, with no
  functional gain over it.
