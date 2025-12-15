# ADR-001: Adopting Architecture Decision Records

Status: Accepted
Date: 2025-12-15
Deciders: @aaronsb

## Context

This project was developed organically without formal architecture documentation. As the codebase has grown and external contributors have begun submitting PRs and issues, we've encountered situations where:

1. Design decisions aren't documented, leading to repeated discussions
2. Contributors propose changes that conflict with undocumented architectural principles (e.g., "less tools, more details" philosophy)
3. Future maintainers (including future-us) lack context on why things were built a certain way

The recent PR #44 and Issue #37 discussions about tool granularity highlighted this gap - we had to conduct research and write up rationale that should have been documented from the start.

## Decision

We are adopting Architecture Decision Records (ADRs) for documenting significant technical decisions going forward.

ADRs will be stored in `docs/adr/` with the format `ADR-NNN-short-description.md`.

We will document:
- Architectural choices (patterns, libraries, approaches)
- Design principles that guide the project
- Decisions with trade-offs that future contributors should understand
- Changes to existing architectural decisions

We will NOT retroactively document every past decision, but will create ADRs as topics come up naturally.

## Consequences

### Positive
- Clear record of why decisions were made
- Easier onboarding for contributors
- Reference point for evaluating PRs against project principles
- Reduces repeated discussions about settled decisions

### Negative
- Additional overhead when making decisions
- Risk of ADRs becoming stale if not maintained

### Neutral
- ADR-001 is meta (documenting the decision to use ADRs)
- Existing undocumented decisions remain undocumented unless revisited

## Notes

Key architectural principles already established (to be documented in future ADRs as relevant):
- "Less tools, more details" - fewer comprehensive MCP tools over many granular ones
- Semantic agency - AI navigates knowledge graph, not just files
- ObsidianAPI abstraction layer - stable interface for vault operations
