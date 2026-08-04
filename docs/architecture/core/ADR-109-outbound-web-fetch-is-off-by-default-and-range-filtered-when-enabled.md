---
status: Draft
date: 2026-08-04
deciders:
  - aaronsb
related:
  - ADR-108
---

# ADR-109: Outbound web fetch is off by default and range-filtered when enabled

## Context

`system.fetch_web` (src/tools/fetch.ts) calls `window.fetch(args.url)` with no
validation. Issue #284 identifies two distinct problems:

1. **SSRF.** Any authenticated MCP client can make the plugin fetch loopback
   services, RFC1918 hosts, link-local and cloud-metadata addresses — targets a
   remote attacker cannot reach on their own — and the response body is
   returned, so this reads as well as probes.
2. **Exfiltration.** The URL itself carries data outbound. An agent processing
   untrusted vault content can be instructed by that content to fetch a public
   host with vault data in the query string. Private-range filtering does
   nothing about this, and read-only mode permits it because `fetch_web` is
   classified as a read.

The tool is enabled by default: `toolVisibility` defaults to `{}` and missing
keys mean enabled (src/main.ts:89). So every install ships a default-on
arbitrary-outbound capability, and the only mitigation is an all-or-nothing
visibility toggle the user has to discover.

A field report sharpened the stakes: a user's antivirus flagged an outbound
connection and their first question was *"is the plugin supposed to make any
kind of outbound ping?"* The investigation cleared the plugin (its only
unsolicited traffic is to the user-configured localhost MCP URL), but the
honest answer today is "it makes no outbound connections *unless* an agent
invokes fetch_web, which is on by default." That answer should be "none, unless
you opted in."

The plugin's core purpose is pointing an agent at a vault, and vault content is
untrusted input. That weighting — convenience of a default-on web fetch versus
containment of an agent reading untrusted notes — is what this ADR decides.

## Decision

**`system.fetch_web` ships disabled by default, for everyone. When the user
enables it, outbound URLs are validated by the security layer against a
blocked-range policy.**

1. **Default-off via a dedicated setting, including existing installs.** The
   gate is a new `enableWebFetch: boolean` (default `false`) presented as its
   own toggle in the security section of settings, beside read-only mode — not
   a row in the tool-visibility tree. The field is absent from every existing
   install's saved settings, so off-for-everyone falls out of the default with
   no migration code. `system.fetch_web` leaves the visibility tree so there
   are not two switches for one capability; a leftover
   `toolVisibility['system.fetch_web']` key is deleted on load — it could only
   have expressed "off", which the new default already says — and the
   release notes announce the change. Safe-by-default wins over continuity
   here because the installed base is exactly the population #284 is about.
   A dedicated setting also reads as a live predicate (the ADR-108 pattern)
   rather than inheriting the visibility tree's next-connection staleness, and
   it gives the two-risks disclosure (decision 4) a place to live.

2. **Range filtering lives in the security layer.** A URL validator under
   `src/security/` (exported through `security/index.ts`) is the one place that
   decides whether an outbound URL is permitted, per the one-enforcement-path
   constraint from ADR-108. It consults `enableWebFetch` live and refuses
   outright when the toggle is off; hiding the action from tool enumeration
   when off is presentation, not enforcement. The fetch tool calls the
   validator; nothing decides inline in the handler.

3. **The filter is canonicalization-first, not string matching.** It must
   refuse, after normalizing the target to an address:
   - IPv4 loopback (127.0.0.0/8), RFC1918 (10/8, 172.16/12, 192.168/16),
     link-local (169.254/16, which includes the 169.254.169.254 metadata
     service), and 0.0.0.0;
   - IPv6 loopback (::1), unique-local (fc00::/7), link-local (fe80::/10), and
     IPv4-mapped forms (::ffff:a.b.c.d) evaluated as their IPv4 address;
   - decimal, octal, and hex encodings of the same addresses
     (2130706433, 017700000001, 0x7f000001);
   - non-http(s) schemes;
   - DNS names whose resolution (every A/AAAA record, via Node `dns.lookup`
     with `all: true`) lands in a blocked range;
   - redirects: every hop re-enters the same validator, with a hop cap.

4. **The fetch itself moves to a security-layer client on Node `http`/`https`
   with the connection pinned to the validated address.** `window.fetch` cannot
   implement this policy: its `redirect: 'manual'` mode returns spec-mandated
   opaque-redirect responses whose `Location` is unreadable, so per-hop
   validation is impossible, and `follow` follows unvalidated hops. The Node
   client surfaces real redirect headers, and overriding the request's
   `lookup` to return the address the validator approved closes the DNS
   rebinding race between check and connect — TLS SNI and certificate
   verification still key off the hostname, so pinning does not weaken HTTPS.
   The plugin already runs a Node HTTP server and uses `fs` in this layer;
   a Node HTTP client in a security control is the same accepted class.

5. **One residual risk is accepted and documented, not hidden.**
   - *Exfiltration to public hosts.* Once the user enables the tool, an agent
     reading hostile vault content can still leak data in a URL to a public
     host. Range filtering cannot address this; only the default-off posture
     does, which is a reason for it, not a filter deficiency. The toggle's
     settings copy states both risks so enabling is informed consent.

## Consequences

### Positive

- The supportable answer to "does this plugin make outbound connections?"
  becomes **"no — only to your configured localhost MCP endpoint — unless you
  enabled web fetch."** For AV-alert reports like the one that motivated this,
  the plugin is eliminable in one sentence.
- SSRF against loopback/LAN/metadata targets is closed for enabled users, with
  an implementation that survives the encodings and redirect games the naive
  hostname check (as in the seanlinmt fork) does not.
- Read-only mode's containment story stops being silently wrong: with the
  default off, "read-only + defaults" genuinely keeps vault data in the vault.

### Negative

- Existing users who rely on `fetch_web` lose it on upgrade until they flip the
  toggle — deliberate, announced, one click to restore.
- The validator adds a DNS resolution to every enabled fetch (negligible next
  to the fetch itself) and a security-layer module that must track range lists.
- Redirect handling, timeouts, and a response size cap move into our client,
  which is more surface than delegating to fetch's follow behavior. The client
  requests `Accept-Encoding: identity` since it does not decompress.

### Neutral
- A host allowlist remains a possible future tightening on top of this posture
  (the validator is the natural seat for it); nothing here forecloses it.
- Obsidian's behavior scan already flags the plugin for network capability;
  default-off may read better there but the finding itself is by-design.

## Alternatives Considered

- **Range block only, tool stays default-on.** No behavior change for existing
  users, but the plugin keeps shipping a default-on arbitrary-outbound
  capability and the exfiltration path stays open by default. Rejected: it
  answers the SSRF half of #284 and ignores the half the issue says matters
  more.
- **Host allowlist, empty by default.** Strongest containment — addresses
  exfiltration even when enabled — but the tool is inert until configured, and
  the settings/docs burden is the largest of the options. Deferred rather than
  rejected; the default-off posture captures most of its value at a fraction of
  the friction, and the allowlist can be layered on later.
- **Per-host confirmation modal.** Keeps the tool usable without config, but
  parks an agent tool call on human presence, adds modal plumbing, and trains
  users to click allow. Rejected.
- **Keep `window.fetch` and accept a rebinding TOCTOU.** The issue's original
  sketch. Rejected once implementation showed manual-redirect mode hides
  `Location` (per the fetch spec's opaque-redirect filtering), which forces a
  choice between not following redirects at all and following them
  unvalidated. The Node client both restores redirects and closes the
  rebinding race, so the "accepted residual" version of this decision was
  strictly worse.
- **Port the seanlinmt fork's guard.** Hostname string matching only; misses
  encodings, DNS resolution, rebinding, and redirects. Rejected in the issue
  already — written fresh instead.
