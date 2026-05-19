---
status: Accepted
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

1. **Content reads are faithful by default — but never context-breaking.**
   `vault.read` returns **byte-exact source** as stored by Obsidian
   (newlines, indentation, trailing whitespace, tabs, fenced blocks,
   frontmatter delimiters preserved — never flattened/fragmented unless
   fragments are explicitly requested). The hard invariant: **a default read
   must not hand the agent a context-breaking raw dump.**

   The paginate/no-paginate boundary is a **character budget**
   (`READ_PAGE_CHARS`, default **50000** ≈ ~12k tokens, one tunable
   constant) — *not* a line count. A line count is an invalid proxy for the
   thing being bounded: 1500 five-word lines and 1500 hundred-word lines
   have wildly different context cost. **Bookends stay line-based** (for
   `edit.at_line`); the two reconcile by defining a *page* as the longest
   run of **whole lines whose cumulative size ≤ `READ_PAGE_CHARS`**,
   reported with the line range it covers. Lines are never split mid-line.

   - **Fits the budget (the common case — most notes):** the **whole file,
     verbatim, in one load**. No pagination structure, no ceremony.
   - **Exceeds the budget:** **page 1 only** — a single *contiguous*
     verbatim block: the longest whole-line run within `READ_PAGE_CHARS`
     (not an array of chunk objects), carrying **bookends**: `lineStart`,
     `lineEnd`, `totalLines`, `bytes`, and a `nextPage` hint
     (`vault.read(path, page=2)`). Absolute line numbers are preserved, so
     `edit.at_line` on a large file still works precisely and the agent
     pages forward instead of a truncated preview, lossy fragments, or a
     context bomb. (A single line that alone exceeds the budget is returned
     whole as its own page — never split — flagged; correctness wins over
     the budget in that rare case.)
   - **`returnFullFile: true`:** explicit override — the entire file
     verbatim regardless of size. `returnFullFile` is therefore **retained
     and repurposed** (not retired): it is the deliberate large-context
     opt-in, used when the agent knowingly accepts the cost.
   - **`query` / `strategy` / `maxFragments`:** semantic fragment retrieval,
     unchanged.

   The read→edit round-trip is correct by construction in every branch
   (per-page content is byte-exact for its line range).

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

Backward compatibility: (1) changes the default shape of `vault.read` for
clients relying on the fragmented/flattened default. Deliberate breaking
change to fix a correctness bug; ships with a changelog entry, the
`strategy`/`maxFragments` opt-in for the old context-saving behaviour, and
`returnFullFile:true` for whole-large-file access. A prerelease + functional
verification of a real read→`edit.window` round-trip (incl. a large file
exercising bookended page 1 → `at_line`) gates the rollout.

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
- Large files no longer return verbatim by default — they return a
  bookended page 1. This is a behavioural change for any client that read a
  large file in one default call; `returnFullFile:true` restores that
  explicitly. Accepted: a context-breaking default is the failure this ADR
  exists to prevent.
- Pagination adds a small surface to `vault.read` (`page` param,
  `lineStart/lineEnd/totalLines/bytes/nextPage` fields). Justified: it's
  what lets large-file `edit.at_line` keep working instead of forcing
  fragments.

### Neutral

- Two-bucket contract should be documented in the README and tool
  descriptions so the default semantics are discoverable.
- `returnFullFile` is retained and repurposed as the explicit
  whole-large-file override (not retired).
- No change to `IObsidianAPI`; the MCP `vault` tool gains a `page`
  parameter and the read response gains pagination bookends.

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
- **Return full verbatim regardless of size (no guard).** Rejected
  outright: a large file dumped raw breaks the agent's context — this is
  the exact failure mode the pagination guard exists to prevent, and the
  reason `returnFullFile:true` is an *explicit, knowing* opt-in.
- **Line-count page budget (e.g. 1500 lines).** Rejected: line count does
  not bound context — 1500 short lines vs 1500 long lines differ by orders
  of magnitude. The budget must be size-based (`READ_PAGE_CHARS`); only the
  *bookends* are line-based, for `at_line`.
- **Array of page/chunk objects in one response.** Rejected: that is just
  the fragmented default in another shape and is not "one load." A page is
  a single contiguous verbatim block; multi-page access is sequential via
  the `page` parameter.
