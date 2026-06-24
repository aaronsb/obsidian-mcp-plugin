#!/usr/bin/env node
'use strict';

const { createInterface } = require('node:readline');

const MCP_URL = process.env.MCP_URL;
const API_KEY = process.env.MCP_API_KEY || '';
const FETCH_TIMEOUT_MS = 30_000;

let sessionId = null;
let notifyAbort = null;
// Serializes dispatch until initialize lands a session id. Subsequent
// messages chain off this promise so they don't race past the handshake.
// Also gates an in-flight self-heal re-initialize so concurrent 404s don't
// each kick off their own handshake.
let initializing = null;
// The last `initialize` we forwarded, kept so the bridge can transparently
// re-establish a session if the server evicts/loses it (issue #238). Replayed
// with a synthetic id and its result suppressed — the client never sees it.
let cachedInitialize = null;
let reinitCounter = 0;

function headers(extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...extra,
  };
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  return h;
}

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function consumeSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frame boundary is a blank line — tolerate LF or CRLF.
    let match;
    while ((match = /\r?\n\r?\n/.exec(buf)) !== null) {
      const frame = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { emit(JSON.parse(data)); }
      catch (e) { process.stderr.write(`[obsidian-mcp-bridge] SSE parse: ${e.message}\n`); }
    }
  }
}

async function startNotifyStream() {
  if (notifyAbort) return;
  notifyAbort = new AbortController();
  try {
    const response = await fetch(MCP_URL, {
      method: 'GET',
      headers: headers({ Accept: 'text/event-stream' }),
      signal: notifyAbort.signal,
    });
    const ctype = response.headers.get('content-type') || '';
    if (response.ok && ctype.includes('text/event-stream')) {
      await consumeSse(response);
    } else {
      // Server doesn't speak the GET stream — drain so the socket releases.
      await response.body?.cancel().catch(() => {});
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      process.stderr.write(`[obsidian-mcp-bridge] notify stream ended: ${e.message}\n`);
    }
  } finally {
    notifyAbort = null;
  }
}

async function postOnce(message) {
  return await fetch(MCP_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Transparently re-establish a session the server has evicted (#238). Replays
// the cached `initialize` (with a fresh synthetic id, result discarded), then
// completes the handshake with `notifications/initialized` so the new session
// is ready for tool calls. Returns true once a fresh session id is in hand.
// Never emits to the client — the caller replays the original message and emits
// that result, so recovery is invisible.
async function reinitialize() {
  if (!cachedInitialize) return false;
  // Drop the dead session so postOnce sends the initialize with no session id.
  sessionId = null;
  if (notifyAbort) { notifyAbort.abort(); notifyAbort = null; }

  let response;
  try {
    response = await postOnce({ ...cachedInitialize, id: `reinit-${reinitCounter++}` });
  } catch (e) {
    process.stderr.write(`[obsidian-mcp-bridge] reinit fetch failed: ${e.message}\n`);
    return false;
  }
  const sid = response.headers.get('mcp-session-id');
  // We only need the session id from the headers; discard the body unread.
  await response.body?.cancel().catch(() => {});
  if (!response.ok || !sid) {
    process.stderr.write(`[obsidian-mcp-bridge] reinit failed: HTTP ${response.status}${sid ? '' : ', no session id'}\n`);
    return false;
  }
  sessionId = sid;

  // Best-effort: a stateful server expects `notifications/initialized` before
  // it will service tool calls. It's a notification (202, no body to emit).
  try {
    const note = await postOnce({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await note.body?.cancel().catch(() => {});
  } catch { /* server may not require it; the replay will reveal the truth */ }

  startNotifyStream();
  return true;
}

async function dispatch(message, isReplay = false) {
  // If we haven't established a session yet and this isn't the initialize,
  // wait for the in-flight initialize (or self-heal re-init) to land first.
  if (!sessionId && initializing && message.method !== 'initialize') {
    try { await initializing; } catch { /* let dispatch surface its own error below */ }
  }

  let response;
  try {
    response = await postOnce(message);
  } catch (err) {
    process.stderr.write(`[obsidian-mcp-bridge] fetch failed: ${err.message}\n`);
    if (message.id != null) {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `Bridge: ${err.message}` } });
    }
    return;
  }

  if (message.method === 'initialize') {
    // Cache the handshake so we can transparently replay it on session loss.
    cachedInitialize = message;
    const sid = response.headers.get('mcp-session-id');
    if (sid) {
      sessionId = sid;
      startNotifyStream();
    }
  }

  if (response.status === 404 && sessionId) {
    // The server evicted/lost our session (idle GC, or a server restart). Per
    // MCP spec the 404 means "re-initialize," but some clients (e.g. Claude
    // Desktop) don't act on it and the connection dead-ends. Self-heal once:
    // re-establish a session and replay this exact message so recovery is
    // invisible to the client (#238). `isReplay` caps it at a single attempt
    // so a session that dies again instantly can't spin a reinit loop.
    if (!isReplay && message.method !== 'initialize' && cachedInitialize) {
      if (!initializing) {
        initializing = reinitialize().finally(() => { initializing = null; });
      }
      let healed = false;
      try { healed = await initializing; } catch { healed = false; }
      if (healed) {
        return await dispatch(message, true);
      }
    }
    sessionId = null;
    if (notifyAbort) { notifyAbort.abort(); notifyAbort = null; }
    if (message.id != null) {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Session expired and automatic reinitialize failed; please retry.' } });
    }
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    process.stderr.write(`[obsidian-mcp-bridge] HTTP ${response.status}: ${text.slice(0, 200)}\n`);
    if (message.id != null) {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `Bridge: HTTP ${response.status}` } });
    }
    return;
  }

  if (response.status === 202) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  const ctype = response.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream')) {
    await consumeSse(response);
  } else {
    const text = await response.text();
    if (!text) return;
    try { emit(JSON.parse(text)); }
    catch (e) { process.stderr.write(`[obsidian-mcp-bridge] JSON parse: ${e.message}\n`); }
  }
}

// Stdio bootstrap. Guarded so the module can be `require`d in tests (which
// drive `dispatch` directly) without validating env, claiming stdin, or
// exiting the process. When launched as the bridge, `require.main === module`.
function main() {
  if (!MCP_URL) {
    process.stderr.write('[obsidian-mcp-bridge] MCP_URL not set\n');
    process.exit(1);
  }
  try { new URL(MCP_URL); } catch {
    process.stderr.write(`[obsidian-mcp-bridge] invalid MCP_URL: ${MCP_URL}\n`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); }
    catch (e) {
      process.stderr.write(`[obsidian-mcp-bridge] stdin parse: ${e.message}\n`);
      return;
    }
    // Capture the initialize promise so concurrent messages can wait for the
    // session id before posting.
    if (msg.method === 'initialize') {
      initializing = dispatch(msg).finally(() => { initializing = null; });
      initializing.catch(err => {
        process.stderr.write(`[obsidian-mcp-bridge] dispatch: ${err.message}\n`);
      });
    } else {
      dispatch(msg).catch(err => {
        process.stderr.write(`[obsidian-mcp-bridge] dispatch: ${err.message}\n`);
      });
    }
  });

  process.stdin.on('end', async () => {
    if (notifyAbort) notifyAbort.abort();
    // Best-effort: tell the server to retire the session so it doesn't linger
    // in the pool until idle GC.
    if (sessionId) {
      try {
        await fetch(MCP_URL, {
          method: 'DELETE',
          headers: headers(),
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* server may have already gone; ignore */ }
    }
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

// Test seam (inert when run as the bridge): expose dispatch and a state reset
// so the self-heal path can be exercised without spawning a process.
module.exports = {
  dispatch,
  reinitialize,
  __reset() {
    sessionId = null;
    notifyAbort = null;
    initializing = null;
    cachedInitialize = null;
    reinitCounter = 0;
  },
  __state() {
    return { sessionId, cachedInitialize, initializing };
  },
};
