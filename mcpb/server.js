#!/usr/bin/env node
'use strict';

const { createInterface } = require('node:readline');

const MCP_URL = process.env.MCP_URL;
const API_KEY = process.env.MCP_API_KEY || '';
const FETCH_TIMEOUT_MS = 30_000;

if (!MCP_URL) {
  process.stderr.write('[obsidian-mcp-bridge] MCP_URL not set\n');
  process.exit(1);
}
try { new URL(MCP_URL); } catch {
  process.stderr.write(`[obsidian-mcp-bridge] invalid MCP_URL: ${MCP_URL}\n`);
  process.exit(1);
}

let sessionId = null;
let notifyAbort = null;
// Serializes dispatch until initialize lands a session id. Subsequent
// messages chain off this promise so they don't race past the handshake.
let initializing = null;

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

async function dispatch(message) {
  // If we haven't established a session yet and this isn't the initialize,
  // wait for the in-flight initialize to land first.
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
    const sid = response.headers.get('mcp-session-id');
    if (sid) {
      sessionId = sid;
      startNotifyStream();
    }
  }

  if (response.status === 404 && sessionId) {
    sessionId = null;
    if (notifyAbort) { notifyAbort.abort(); notifyAbort = null; }
    if (message.id != null) {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Session expired; please reinitialize' } });
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
