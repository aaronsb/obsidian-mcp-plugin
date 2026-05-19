---
status: Proposed
date: 2026-05-19
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-203: Faithful-by-default content reads; concise-by-default tool results

## Context

#133 argues that because MCP is a machine-to-machine protocol, the default
tool response should be structured/source data, and that forcing every
client to pass `raw: true` everywhere pushes presentation concerns into
every consumer. Its proposed remedy is a **global flip**: make `raw: true`
behavior the default, opt into rendered output with `render: true`.

Empirical inspection of 0.11.29 (live calls + the response code paths in
`src/tools/semantic-tools.ts` and `src/utils/file-reader.ts`) shows the
real situation is sharper than the issue states, and the global flip is the
wrong lever:

1. **The default content read is *lossy*, not merely "rendered."** Default
   `vault.read` does **not** return the file. `file-reader.ts` returns full
   content only when `returnFullFile` is set; otherwise it falls through to
   fragment retrieval, and the presentation facade then renders fragments
   with **newlines/whitespace flattened to spaces**. Measured on a tiny
   structured file, the default read collapsed frontmatter, headings, a
   fenced Python block (indentation lost) and a trailing tab onto a single
   line. An agent that derives an `edit.window` `oldText` from a default
   read gets text that **cannot match the file on disk**. This is a
   correctness defect in the read→edit round-trip, and a likely contributor
   to the `edit.window` fuzzy-match fragility the project has been
   compensating for elsewhere.

2. **The faithful path is needlessly ~2× bloated.** With
   `returnFullFile: true, raw: true`, the complete file body is embedded
   **twice** — `result.content.content` and `result.metadata.content` are
   byte-identical — on top of `workflow`/`suggested_next`/`context`
   boilerplate. Roughly half of the "raw" read payload is pure duplication.

3. **`returnFullFile` without `raw` is broken.** The presentation formatter
   throws on the full-file shape and emits a literal
   `_Formatter error, showing raw data:_` JSON fallback. There is no working
   concise full-file formatted view today.

4. **A global flip would make tool *results* more verbose.** The default
   formatted path (`formatResponse`) is a deliberately condensed,
   token-efficient summary for action/result tools (create/edit/move/
   search). `raw: true` produces the full pretty-printed envelope —
   *more* tokens. Flipping the global default to `raw` therefore works
   directly against response economy for the common case (#133's own stated
   value — "less verbose" — is served by the current result formatting, not
   by the flip).

The intent behind #133 is correct (a machine protocol's default output
must be machine-usable). The instinct that the project also wants — concise
formatted output for tool *results*, but unaltered content for *editing* —
is also correct. The two are reconciled by separating **content reads**
from **action/result rendering** rather than by one blunt format switch.

## Decision

Adopt a **two-bucket response contract**. This ADR is the decision of
record; implementation is tracked separately and is *not* part of this ADR.

1. **Content reads are faithful by default.** `vault.read` returns the
   **complete, verbatim file source** by default — byte-exact as stored by
   Obsidian (newlines, indentation, trailing whitespace, tabs, fenced
   blocks, frontmatter delimiters preserved). Fragmentation / summarization
   becomes an **explicit opt-in** for large-file context savings via the
   *existing* knobs (`query`, `strategy`, `maxFragments`); `returnFullFile`
   is no longer required to get the truth and is retired or demoted to a
   no-op alias. The read→edit round-trip is correct by construction.

2. **Action/result outputs stay concise-formatted by default.** Tools whose
   result is a status / confirmation / list (create, update, delete, move,
   rename, copy, search, graph.*, edit.*) keep the condensed
   `formatResponse` presentation as the default — the token-efficient
   ergonomics are intentional and retained. `raw: true` remains the
   explicit opt-in for the full structured envelope on these. #133's
   global-flip proposal is **declined**; its intent is satisfied by
   bucket 1.

3. **Stop double-encoding the body.** The structured read envelope must not
   embed the file content twice. `metadata` carries metadata (path,
   wordCount, tags, frontmatter, warning) — not a second copy of the body.
   Orthogonal to the default change and applies regardless.

4. **The full-source path must not depend on the broken formatter.**
   Verbatim content is returned through a path that does not throw the
   `_Formatter error_` fallback; the failing `returnFullFile` formatted
   branch is fixed or removed as part of (1).

Backward compatibility: (1) changes the default shape/size of `vault.read`
for clients that currently rely on the fragmented/flattened default. This
is a deliberate breaking change to fix a correctness bug; it ships with a
clear changelog entry and a documented opt-in (`strategy`/`maxFragments`)
for the previous context-saving behaviour. A prerelease + functional
verification of a real read→`edit.window` round-trip gates the rollout.

#133 is **reframed, not closed by fiat**: it remains the user-facing
tracking issue for bucket 1; this ADR records the agreed direction and
explicitly supersedes its specific "global `raw` flip" remedy.

## Consequences

### Positive

- Read→edit round-trips become correct by default: `edit.window`/`patch`
  `oldText` derived from a read matches disk. Removes a structural source
  of the fuzzy-match fragility.
- Honours #133's intent (machine-usable default) without the verbosity
  regression a global flip would cause for action/result tools.
- De-duplicating the body roughly halves structured-read payloads — a free
  win for every `raw` consumer, independent of the default change.
- Fixes a latent crash (`returnFullFile` formatter throw).

### Negative

- Breaking change for clients depending on the current fragmented/flattened
  default `vault.read` (smaller, lossy payloads). Mitigated by changelog,
  the existing `strategy`/`maxFragments` opt-in for context savings, and a
  gated prerelease test.
- Large files now return full content by default → higher per-call context
  cost for the read-everything pattern. Mitigated: fragmentation is still
  one explicit parameter away, and a `wordCount`/size `warning` is retained
  to nudge large-file callers toward it.

### Neutral

- Two-bucket contract should be documented in the README and tool
  descriptions so the default semantics are discoverable.
- `returnFullFile` becomes redundant; retire or alias with a deprecation
  note.
- No change to `IObsidianAPI` or the MCP tool surface beyond the default
  response shape/size of `vault.read` and the de-duplicated envelope.

## Alternatives Considered

- **#133 as written — global flip to `raw` default, `render:true` opt-in.**
  Declined: makes every action/result return more verbose (against the
  project's "concise tool results" goal), and still wouldn't fix the
  newline-flattening fidelity bug — the default read is lossy *before* it
  reaches the format switch.
- **Status quo (require `returnFullFile:true` + `raw:true` for fidelity).**
  Rejected: read→edit correctness must not depend on two non-obvious
  opt-ins; this is the exact friction #133 documents and the latent cause
  of silent edit mismatches.
- **Keep fragmented default but stop flattening newlines.** Rejected as
  insufficient: a fragment is still a *subset* of the file; an agent
  editing needs the whole, exact source, not faithfully-formatted excerpts.
- **New dedicated `vault.source` tool, leave `read` lossy.** Rejected:
  splits the surface and leaves the obvious tool (`read`) a footgun; the
  principled fix is making the obvious tool correct by default.
