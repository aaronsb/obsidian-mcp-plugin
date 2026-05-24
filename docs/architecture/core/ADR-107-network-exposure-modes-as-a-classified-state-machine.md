---
status: Accepted
date: 2026-05-24
deciders:
  - aaronsb
  - claude
related:
  - ADR-103
---

# ADR-107: Network exposure modes as a classified state machine

## Context

The MCP HTTP server's exposure is determined by the combination of three
independent settings — **protocol** (HTTP / HTTPS), **bind address** (which
network interface(s) `server.listen` attaches to), and **certificate
provenance** (self-signed vs. user-supplied) — but the code today treats
each as an isolated knob with no awareness of the combined state.

Two concrete consequences of that:

1. **The bind address has no setting at all.** `this.server.listen(this.port, …)`
   is called without a host argument (`src/mcp-server.ts:638`,
   `src/node-mcp-server.ts:52`), so Node binds the wildcard (`0.0.0.0`) —
   every interface, LAN-reachable. There is no UI to change this and no
   documentation that it is the default. ADR-103 §"Zero-config" already
   states *"The server listens on `127.0.0.1` over HTTP by default"* — that
   premise is aspirational, not actual; this ADR is partly what makes it
   true.
2. **The dangerous combination is silent.** A user who toggles "HTTPS
   disabled" (the default) is, today, serving the API key and vault
   contents in cleartext to every interface — including the coffee-shop
   wifi the laptop is on. The plugin offers no signal that this state is
   different in kind from `http + 127.0.0.1`, even though one is local-only
   and the other is broadcast.

Community PR #208 (fa1k3, 2026-05-20) flags the bind half of this and
proposes hardcoding `127.0.0.1`. That fixes the default but removes the
escape hatch for the legitimate "Obsidian on machine A, MCP client on
machine B" deployments the plugin's HTTPS path implies are supported.

A fair counter is that most competently-administered systems already
have a host firewall (Linux `ufw`/`firewalld`/`nftables`, macOS
Application Firewall, Windows Defender Firewall) that would silently
drop unsolicited LAN connections regardless of what the plugin binds
to. That's often true, and where it holds, today's implicit `0.0.0.0`
bind is harmless in practice. The plugin nonetheless **cannot detect,
depend on, or assume** that posture — the population includes
freshly-installed machines, end-user laptops where the firewall has
been disabled to make some other tool work, containers and VMs with
permissive network policies, and the long tail of "I thought it was
on." Outsourcing the default to a firewall the plugin can't observe
is the wrong direction; the plugin owns its own default. Firewall
hardening on the host stays out of scope.

The deeper observation is that **risk is a function of the combination,
not any single axis**. Cleartext on loopback is fine; cleartext on any
other interface is a leak. Self-signed TLS on loopback is fine;
self-signed TLS on a LAN interface is encrypted but trust-on-first-use.
Real cert on `0.0.0.0` is the intended remote-access deployment. A scheme
that warns or guides on a single axis will misclassify these — either
nagging the safe cases or staying silent on the unsafe ones. The right
shape is a small finite state machine that classifies the combined state
and surfaces that classification both in the UI and to the LLM client.

## Decision

**Model network exposure as a 9-state classified state machine. Resolve
the combined state at server-bind time with a pure `classify()` function.
Surface the verdict in the settings UI and — for the dangerous-tier only
— in the MCP `initialize` instructions so the LLM client also sees it.
Never refuse to bind: warn loudly, always start.**

### Settings

Replace the implicit Node-default bind with three new settings that
together with the existing `httpEnabled`/`httpsEnabled`/`certificateConfig`
fully specify the network state:

```ts
interface MCPPluginSettings {
  // existing...
  httpEnabled: boolean;
  httpPort: number;
  httpsEnabled: boolean;
  httpsPort: number;
  certificateConfig: CertificateConfig;   // .selfSigned discriminates cert source
  // new:
  bindMode: 'loopback' | 'all' | 'custom';   // default: 'loopback'
  customBindHost: string;                    // consulted only when bindMode === 'custom'
}
```

`bindMode` is a discriminated enum, not a free-text host, so the common
intents (loopback / wildcard) cannot be typoed and the UI can render
three labelled choices instead of a string field full of footguns. The
custom path remains for the genuine LAN-bind case.

The settings UI normalizes custom input on blur:

- `127.0.0.1` / `localhost` / `::1` → switch dropdown to **Loopback**,
  blank `customBindHost`
- `0.0.0.0` / `::` → switch dropdown to **All interfaces**, blank
  `customBindHost`
- anything else → keep **Custom**, persist as-typed

This means the user expressing "loopback" three different ways all
converge to the same internal state, which the classifier can reason
about cleanly.

### State machine

Three axes, with cert only consulted under HTTPS, give nine distinct
states. Each gets one of three verdicts: 🟢 OK, 🟡 WARN, 🔴 JAIL.

| # | Protocol | Bind     | Cert | Class | Why |
|---|----------|----------|------|-------|-----|
| 1 | http  | loopback            | —    | 🟢 OK   | Traffic never leaves the machine — encryption moot |
| 2 | http  | custom-non-loopback | —    | 🔴 JAIL | Vault contents + API key travel cleartext on a wire |
| 3 | http  | all                 | —    | 🔴 JAIL | Same, broadcast to every interface |
| 4 | https | loopback            | self | 🟢 OK   | Self-signed fine on loopback; no MITM surface |
| 5 | https | loopback            | user | 🟢 OK   | Overkill but harmless |
| 6 | https | custom-non-loopback | self | 🟡 WARN | Encrypted, but client must TOFU the cert |
| 7 | https | custom-non-loopback | user | 🟢 OK   | The intended LAN/remote deployment |
| 8 | https | all                 | self | 🟡 WARN | Encrypted with TOFU; wider exposure |
| 9 | https | all                 | user | 🟢 OK   | The intended public deployment |

The classification function is pure and table-driven:

```ts
type NetworkState = {
  protocol: 'http' | 'https';
  bind: 'loopback' | 'all' | 'custom-loopback' | 'custom-other';
  certSource: 'self' | 'user';   // only meaningful under https
};

type Verdict = { class: 'ok' | 'warn' | 'jail'; reason: string };

function classify(s: NetworkState): Verdict { /* the table above */ }
```

`bind` is resolved from `bindMode` + `customBindHost` before classification:
a custom value that resolves to a loopback alias (`127.x.x.x` / `::1` /
`localhost`) classifies as `custom-loopback` and is treated as loopback
for risk purposes; everything else is `custom-other`.

### Server-bind behavior

At server start, after resolving the listen host:

1. Compute `verdict = classify(currentState)`.
2. **Always call `listen(port, resolvedHost)`** — the server starts in
   every state including 🔴. We do not gate startup on the verdict.
3. If `verdict.class === 'jail'`: emit a `Notice` ("⚠️ MCP server is
   serving vault contents over an unencrypted network interface. API key
   and document text travel in cleartext. Reconfigure to HTTPS or
   loopback in the plugin settings.") and log a `Debug.error`. Persist a
   small per-session flag so the Notice is shown once per process boot,
   not on every request.
4. If `verdict.class === 'warn'`: log a `Debug.warn` summarizing the
   trade-off. No `Notice` — the settings-pane badge handles the visual.

### Agent-visible hint (🔴 only)

The MCP `initialize` response includes an `instructions` string field per
the protocol. When the current verdict is 🔴, that field is populated
with a warning the LLM will see on its first turn against the server —
something like:

```
SECURITY WARNING: This Obsidian MCP server is configured to serve vault
contents over an unencrypted network interface ({resolvedHost}:{port}).
The API key and all document text travel in cleartext over the network.
If the user did not intend this, advise them to reconfigure the plugin
to use HTTPS or to bind to loopback (127.0.0.1) only.
```

When the verdict is 🟡 or 🟢, the `instructions` field carries the normal
plugin description (or is absent). The agent is *only* nagged when the
state genuinely warrants it. `http + 127.0.0.1` is silent because there
is nothing to warn about.

### Settings UI

The network section of the settings tab gains a **mode badge** at the
top that reflects the live verdict — a colored pill with a one-line
explanation. Changing any control (protocol toggle, bind dropdown,
custom host field, cert path) re-runs `classify()` and updates the
badge without saving. When the badge is 🔴 it includes a `Reconfigure`
hint pointing at the bind dropdown.

The bind dropdown labels are explicit:

- *Loopback only — local machine* (recommended)
- *All interfaces — anyone on the network can attempt to connect*
- *Custom address…*

The "All interfaces" choice renders an inline red caution beneath it
whenever it is selected, regardless of protocol — the caution language
shifts based on whether HTTPS is also on (cleartext vs. TOFU-encrypted).

### Migration

`bindMode` defaults to `'loopback'` and `customBindHost` to `''`. On the
upgrade-from-old-settings path, missing fields take these defaults, so
existing installs that had been implicitly serving `0.0.0.0` (every
install today) land on `127.0.0.1`. This is a deliberate behaviour
change for the small fraction of users who were relying on LAN access:
they will see "connection refused" from their LAN client, open settings,
flip the bind dropdown to **All interfaces**, observe the red caution,
and proceed knowingly. The one-time disruption is the price of fixing
the insecure default; preserving the old behaviour for upgrades would
half-defeat the change. A first-run-after-upgrade `Notice` ("Network
binding now defaults to loopback — open MCP settings if you previously
relied on LAN access") softens the transition without preserving the
default.

## Consequences

### Positive

- The dangerous-by-default state (HTTP on every interface, no warning)
  ceases to exist. New installs and upgrades land in 🟢 unless the user
  explicitly opts into a riskier state with the warning visible.
- The combined state is named and classified, so future changes
  (additional axes, new transports) extend the table rather than spawn
  new ad-hoc warnings.
- The LLM client gets the same security signal the user does in the 🔴
  case — useful when the user has handed Claude Code or Claude Desktop
  the connection and isn't watching the plugin UI.
- ADR-103's "loopback by default" premise becomes actually true,
  retroactively justifying the analysis there.
- The escape hatch for legitimate LAN/remote deployments remains —
  fa1k3's hardcoded-loopback approach would have removed it; this design
  preserves the capability while making the trade-off visible.

### Negative

- Existing installs that depended on the implicit `0.0.0.0` bind break
  on upgrade and require two clicks to restore. Migration `Notice`
  helps but does not eliminate the friction.
- More settings surface area (one enum, one string) and more UI (the
  badge, the inline caution, the dropdown). The configurability budget
  this spends is real.
- The `classify()` table is a small piece of policy now living in code.
  Future protocol additions (e.g., Unix sockets, IPC) need to extend
  both the axis enums and the table consistently.

### Neutral

- The MCP `initialize` instructions field is being used as a warning
  channel only in the 🔴 case. Other future uses of that field need to
  cooperate (compose with the warning, or accept that the warning takes
  precedence when present).
- Self-signed-on-LAN (rows 6, 8) is 🟡 rather than 🔴 because the
  encryption is real even if the trust model is TOFU. Users who consider
  this insufficient can supply a real cert and the state moves to 🟢.
- Server startup behaviour is unchanged in the bind-success case — the
  classification is observational, not gating. Removing the gate
  (vs. an earlier proposal to refuse-to-start in 🔴) keeps the plugin
  from appearing broken to upgrading users and matches the existing
  "warn loudly, let the user decide" posture elsewhere in the plugin.

## Alternatives Considered

- **Hardcoded loopback (PR #208 as submitted).** Fixes the default but
  removes the escape hatch for legitimate LAN/remote deployments the
  plugin's HTTPS path is built for. Rejected as too coarse — the right
  default with the wrong shape. fa1k3's PR will be thanked and closed
  with a pointer to this ADR; the security instinct is the inspiration
  for the work.
- **Free-text bind-host setting with prose warnings.** A single string
  field for the bind address with a tooltip explaining the risks.
  Rejected because tooltips don't get read, and a string field offers
  no way to express "I want loopback" without re-deriving the address —
  the discriminated enum makes intent first-class.
- **Refuse-to-start in 🔴 with an "I accept the risk" override toggle.**
  Earlier draft of this design. Rejected on UX grounds: a user who
  upgrades and lands in 🔴 because of a deliberate-but-undeclared
  LAN setup will perceive the plugin as broken until they read the
  Notice and find the override. "Loud warning, always start" matches
  the plugin's posture elsewhere (e.g., `dangerouslyDisableAuth`
  warns but does not refuse) and treats the user as capable of acting
  on the warning.
- **Heuristically lenient classification for RFC1918 private ranges.**
  Treat `192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` more leniently
  than a public IP. Rejected as overreach — a private IP on a hostile
  network (corporate guest wifi, conference network, shared VPS in
  bridged mode) is no safer than a public one, and the protocol/cert
  axes already handle the actual encryption risk. Pretending the bind
  value alone tells us about network trust would be false confidence.
- **Always-on agent-visible warning regardless of state.** Pin the
  warning into MCP `initialize` instructions for every state. Rejected
  because nagging the 🟢 cases would train both users and models to
  ignore the channel — the warning loses force precisely when it
  matters most.
