---
status: Accepted
date: 2026-05-18
deciders:
  - aaronsb
  - claude
related: []
---

# ADR-106: Client-driven session re-initialization via spec-compliant HTTP 404

## Context

After ~3h idle, the MCP session is silently dropped and **every** subsequent
tool call fails with HTTP 400 `"Bad Request: Server not initialized"`,
unrecoverable without restarting the MCP client (#128, user-facing symptom;
#190, the engineering investigation). The root cause was proven against
`@modelcontextprotocol/sdk@1.29.0` (the version on `main`) and re-verified
during this work:

When a request arrived bearing an `Mcp-Session-Id` the server no longer held
a transport for (session evicted), the handler tried a **server-side
synthetic `initialize`**: it built `compatReq = { ...req, headers }` — a
plain object, not a `stream.Readable` — and fed it to SDK 1.29's
`StreamableHTTPServerTransport.handleRequest`. SDK 1.29 delegates to
`@hono/node-server`'s `getRequestListener`, whose `Readable.toWeb(incoming)`
cannot consume a non-stream; even with a real `IncomingMessage`,
`getRequestListener` throws `RequestError("Missing host header")` → 400, and
an `accept` header set post-construction does not survive hono's lazy Web
`Request` reconstruction → SDK 406. **No synthetic-Node-object path reaches
`_initialized = true` on SDK 1.29.** The synthetic init always failed,
"failed open," and fell through to the 400. Two community PRs (#147 real
`IncomingMessage`; #150 retry-with-backoff) were reviewed and declined: the
failure is *deterministic*, not transient, and operates at the wrong layer.

The Streamable HTTP transport spec already defines the correct recovery
mechanism (Session Management):

- **§3** — the server **MAY** terminate a session at any time, after which
  it **MUST** respond to requests carrying that session ID with **HTTP 404**.
- **§4** — a client receiving **HTTP 404** for a request bearing an
  `Mcp-Session-Id` **MUST** start a new session by sending a fresh
  `InitializeRequest` with no session ID.
- **§2** — a non-initialize request with no `Mcp-Session-Id` **SHOULD** get
  **HTTP 400**.

The server was doing none of this for the evicted-session case; it
fabricated a phantom transport and returned a non-spec
`400 -32000 "Server not initialized"`, which no client treats as a
session-expiry signal — hence the unrecoverable loop.

## Decision

**Stop attempting server-side synthetic initialization. Emit the spec's
session-lifecycle signal and let the client re-initialize itself
(client-driven re-init).**

In `MCPHttpServer.handleMCPRequest`:

- Keep the three transport-binding paths unchanged: existing live session;
  recreate-on-`initialize` for a known session ID; fresh `initialize` with
  no session ID.
- For a non-`initialize` request whose `Mcp-Session-Id` has no live
  transport (evicted/stale): respond **HTTP 404** with the
  `Mcp-Session-Id` echoed and a courtesy JSON-RPC error body
  (`code: -32001`, message instructing re-initialize). Spec §3.
- For a non-`initialize` request with no `Mcp-Session-Id`: respond
  **HTTP 400**. Spec §2.
- Delete the synthetic compat-initialize block, the `requireInitializeNotice`
  machinery, the `createNullRes`/`NullResponse` shim, and the phantom
  transport creation. A spec-compliant client/bridge re-initializes on the
  404 and the **next** request opens a fresh session normally — no client
  restart (fixes #128).

The HTTP status is the load-bearing signal; the JSON-RPC body is courtesy.
`DELETE /mcp` (spec §5) is already handled and is left as-is.

### Acceptance (restated for this direction)

#190's original acceptance ("non-initialize request returns 2xx") was
written before a direction was chosen and described the *server-heal*
candidate. For client-driven re-init the equivalent recovery is:

> A non-`initialize` request bearing an evicted `Mcp-Session-Id` returns
> **HTTP 404 with the `Mcp-Session-Id` header set** (spec §3 signal), **and**
> a subsequent `initialize` request with no session ID returns **2xx with a
> fresh `Mcp-Session-Id`** (a working new session). Together the client
> recovers without a restart, per spec §4. Asserted by a harness driving the
> request pair through the handler against the SDK version on `main`.

### Known client caveat

Spec §4 is the client's obligation. `mcp-remote` does not "clear session +
reinit" explicitly; on a 404 it recurses through `connectToRemoteServer`
with a fresh transport, whose first message is an `initialize` with no
session ID — the same observable outcome. Some clients (e.g. certain Claude
Code builds) reportedly do not honor §4 at all. That is an upstream client
gap, not something the server can paper over without re-introducing the
proven-broken synthetic-init class. The server's contract is the spec;
end-to-end recovery is validated by functional test against the real
client/bridge.

## Consequences

### Positive

- #128 becomes recoverable without a client restart on spec-compliant
  clients/bridges; the unrecoverable 400 loop is gone.
- Deletes a large block of proven-broken, SDK-version-fragile synthetic-init
  code and its shims; the handler now expresses exactly the spec's state
  machine.
- No dependency on SDK internals or hono request reconstruction — robust
  across SDK upgrades.

### Negative

- Recovery depends on the client honoring spec §4. Clients that don't will
  still need a manual reconnect — but they did before too, and the server is
  now spec-correct rather than emitting a misleading non-spec 400.
  Mitigation: validated by functional test against the actual
  Claude/`mcp-remote` path.

### Neutral

- Requires a functional re-test against a real client (BRAT prerelease →
  reconnect) to confirm end-to-end recovery; covered by the project's
  prerelease loop.
- A deterministic regression harness drives the synthetic request pair
  through `handleMCPRequest` and asserts the 404+header / 2xx-reinit pair;
  added with this change.

## Alternatives Considered

- **#147 — real synthetic `IncomingMessage` round-tripped through hono.**
  Rejected: still cannot reach `_initialized` on SDK 1.29 (RequestError →
  400, then 406); right instinct, wrong layer (proven empirically).
- **#150 — retry the synthetic init with backoff.** Rejected: the failure
  is deterministic, not transient; retry only adds latency before the
  identical failure.
- **Cosmetic status rewrite (`-32001 "session expired"`).** Rejected: a
  body relabel is not a recovery; clients still don't re-init and the loop
  persists. Explicitly called out as a non-fix in #190.
- **Server-side session keep-alive / TTL extension to prevent the drop.**
  Rejected as the primary fix: it narrows the window but does not make a
  *dropped* session recoverable (network loss, restart, eviction under
  pressure still strand the client). Orthogonal; may be revisited
  separately. The spec's 404/re-init path is the designed recovery and is
  needed regardless.
