---
status: Accepted
date: 2026-05-16
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-300: Single-branch release strategy with prerelease/promote

## Context

Obsidian retired the `obsidianmd/obsidian-releases` pull-request submission
process and moved community-plugin submission/maintenance to the developer
portal at community.obsidian.md. After migration, our listing reported
"No release matches your manifest version" even though tag `0.11.21` existed
with correct (no-`v`-prefix) format and matching `versions.json` entry. The
cause: the portal only scans the latest **stable** GitHub release, and
`0.11.21` was flagged as a prerelease while `0.11.20` was the latest stable.
`make promote` resolved it.

This raised a broader question: should we add a dedicated long-lived
**release branch** for the Obsidian community, letting `main` move fast
(prereleases, experimental work) while a slower branch holds only
community-blessed commits?

Investigation established two facts:

1. `main` is already release-safe. Pushing to `main` triggers no release;
   `release.yml` is `workflow_dispatch`-only. Releases are deliberate acts.
2. Releases ship as **prereleases by default**; the portal and auto-update
   users only ever see the one release deliberately promoted via
   `make promote`.

The deciding question was whether `main` carries work that must *never*
reach a community release (permanent divergence) or merely "not yet"
(temporal lag). The answer: **same code, slower cadence** — nothing on
`main` is permanently excluded from community releases; the community simply
gets blessed commits later.

## Decision

Maintain a **single `main` branch**. Do **not** introduce a release branch
for the Obsidian community.

Decouple our development cadence from community expectations **temporally,
not structurally**:

- Work proceeds on `main`. `make release-*` cuts prereleases at any cadence;
  BRAT testers ride these with no community impact.
- When a prerelease is proven, `make promote` flips it to stable + "Latest".
  That release — and only that release — is what the Obsidian directory and
  auto-update users receive.
- "Slower community cadence" is expressed as **promoting less often than we
  prerelease**. The gap between latest prerelease and latest promoted release
  *is* the decoupling.
- Promotion is a deliberate bless gate, not reflexive. The portal's
  "preview a branch scan" (branch/tag/SHA) may be pointed at a candidate tag
  as a pre-promote validation check — it is a dry-run tool, not a
  distribution channel.

## Consequences

### Positive

- No version-file divergence. `package.json`, `manifest.json`,
  `versions.json`, `src/version.ts` have one source of truth on `main`.
- No cross-branch cherry-pick discipline or recurring version-bump merge
  conflicts.
- Decoupling is achieved with the mechanism that already exists; no new
  process to learn or maintain.

### Negative

- The fast/slow boundary lives in human discipline (when to `make promote`)
  rather than in branch structure. A reflexive promote collapses the
  decoupling.

### Neutral

- Requires that `make promote` remain a conscious, infrequent act relative
  to prerelease cadence.
- If the relationship ever changes to *permanent* divergence (community-only
  metadata, gated-out features), this decision must be revisited — a release
  branch would then be justified and this ADR superseded.

## Alternatives Considered

- **Dedicated Obsidian community release branch.** A long-lived branch
  holding only blessed commits, releases cut from it, `main` racing ahead.
  Rejected: for "same code, slower cadence" it reproduces — at the cost of
  permanent version-file divergence and cherry-pick discipline — a
  decoupling the prerelease/promote flow already provides for free. Its only
  genuine value is permanent divergence between `main` and community builds,
  which does not apply here.
- **Stable-by-default releases (drop prerelease default).** Removes the
  `make promote` step. Rejected: eliminates the bake-in-prerelease safety
  valve that BRAT testing depends on; every release would hit all users and
  the directory immediately.
