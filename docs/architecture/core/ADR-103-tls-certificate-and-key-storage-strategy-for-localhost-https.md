---
status: Accepted
date: 2026-05-16
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-103: TLS certificate and key storage strategy for localhost HTTPS

## Context

The optional HTTPS server uses a self-signed certificate. When none is
configured, `certificate-manager.ts` generates one and writes the cert +
private key with `fs.writeFileSync` to:

```
<vault base path>/<configDir>/plugins/semantic-vault-mcp/certificates/default.{crt,key}
```

`configDir` is `.obsidian` by default. This is the plugin's data directory,
**not** the synced note tree, and Obsidian's vault sync does not carry it by
default. The key is therefore **per-instance**: each machine that enables
HTTPS generates and keeps its own.

A recurring design question keeps resurfacing — stated plainly as: *"if the
plugin already has vault access, would it be acceptable to keep the TLS key
in the vault?"* Storing it in the synced tree would make the opt-in HTTPS
path zero-config on every synced instance — generate once, it travels — at
the cost of **one shared private key** across all of a user's (or a team's)
machines. The pull is real enough that it needs a recorded decision, not
another ad-hoc re-litigation.

This intersects the "Direct Filesystem Access" review finding (the `fs`
write here), which is already analysed and **accepted** as load-bearing in
`CLAUDE.md` — this ADR is about *where the key lives*, not whether `fs` is
used.

## Decision

**Keep the status quo: a per-instance, auto-generated, non-synced
self-signed cert/key. Do not move the private key into the synced vault.**

And resolve the recurring question by **documenting the HTTPS scope** so it
stops being re-opened: HTTPS here is *opt-in, loopback-only, and
identity-asserting-nothing*; the zero-config property it seems to want
already exists elsewhere (see below). The question dissolves once the scope
is written down.

Rationale:

1. **A localhost self-signed cert asserts no identity.** Its only job is to
   encrypt loopback traffic; `CN=localhost` is trusted by nothing and
   proves nothing. Its sensitivity is far below that of an identity
   certificate — the threat a shared key would worsen is small to begin
   with.
2. **The API key is the real secret, and it already syncs.** The bearer
   token in the plugin's synced settings is what actually gates access, and
   it already travels wherever plugin settings are synced. Secret-hygiene
   effort belongs there (tracked separately: env-var API key, #135), not on
   a loopback TLS key. Optimising the low-value secret while the high-value
   one is the open lever is misdirected energy.
3. **Zero-config already exists — via the HTTP default, not a synced key.**
   The server listens on `127.0.0.1` over HTTP by default and works on any
   instance with no setup. HTTPS is the *opt-in* path; syncing its key
   would help only the minority who both enable HTTPS *and* run multiple
   synced instances.
4. **Defense-in-depth, specifically for shared/team vaults.** A per-instance
   key contains a compromise to one machine and is regenerated locally for
   free. A vault-shared key is a single point of failure that cannot be
   revoked per instance and would silently propagate to every member of a
   shared vault — eroding isolation exactly where it matters most, to buy
   convenience that point 3 shows is largely already delivered.

## Consequences

### Positive

- Compromise of one machine's loopback TLS key does not implicate any other
  instance; rotation is local and costless.
- Shared/team vaults do not silently distribute a private key.
- The HTTPS scope is now written down; the question stops recurring.

### Negative

- A user running HTTPS across several synced instances must accept each
  instance's own self-signed cert (or supply their own). This is the
  intended trade and is mild given the HTTP default already needs no setup.

### Neutral

- No code change. `certificate-manager.ts` behaviour is unchanged; this ADR
  ratifies and documents it.
- Independent of, and does not alter, the accepted "Direct Filesystem
  Access" finding.
- Relates to #135 (env-var API key) as the place the real secret-hygiene
  work lives.

## Alternatives Considered

- **(b) Vault-shared key (the intrusive thought).** Solo-convenient:
  generate once, every synced instance gets HTTPS with no setup. Rejected —
  one non-revocable private key shared across machines and shared-vault
  members is a defense-in-depth regression, and the convenience it buys is
  marginal because the HTTP-on-localhost default already provides
  zero-config; only the opt-in HTTPS minority benefits.
- **Per-instance key, but sync only the public cert** (so clients could
  pin). Rejected as overkill: localhost self-signed clients
  trust-on-first-use or disable verification anyway; syncing a public cert
  adds moving parts for negligible gain.
- **Leave it undocumented and decide case-by-case.** Rejected — the
  question has already resurfaced more than once; the cost here is the
  absence of a written scope, and an ADR is exactly the friction that fixes
  that.
