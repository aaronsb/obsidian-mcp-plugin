/**
 * Regression harness for the bridge bootstrap (0.11.34 boot bug).
 *
 * The .mcpb bridge (mcpb/server.js) is bundled as a single file and launched as
 * a process. The unit tests (bridge-self-heal) `require()` it and drive
 * `dispatch` directly — which by design skips `main()` — so they cannot catch a
 * failure to *start*. That gap shipped: #243 gated startup on
 * `require.main === module`, but Claude Desktop loads the bundle with its
 * built-in Node via a loader that does NOT make server.js the main module, so
 * main() never ran, stdin was never read, and `initialize` hung until Desktop's
 * 60s timeout.
 *
 * This test actually spawns the bridge against a stub HTTP server and asserts it
 * answers `initialize` — in BOTH launch shapes:
 *   1. `node server.js`                  (require.main === module)
 *   2. `node -e "require('server.js')"`  (require.main !== module — Desktop-like)
 * Mode 2 is the one that regressed.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const SERVER = path.resolve(__dirname, '../mcpb/server.js');
const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

// Minimal MCP HTTP stub: answers initialize with a session id + result, drains
// the GET notify stream, and 200s everything else. Enough for the bridge to
// complete a handshake and emit the initialize result to stdout.
function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(200).end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'stub-session' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub' } } }));
        } else {
          res.writeHead(202).end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Spawn the bridge with the given node args, feed it `initialize`, and resolve
// with the first JSON object it writes to stdout (the initialize result).
function bootAndInitialize(nodeArgs: string[], mcpUrl: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Strip JEST_WORKER_ID: the child IS a real bridge launch, and the bootstrap
    // guard deliberately skips main() when that var is present (test seam).
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_URL: mcpUrl, MCP_API_KEY: 'k' };
    delete env.JEST_WORKER_ID;

    const child = spawn(process.execPath, nodeArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no initialize response (bridge hung). stderr: ${err}`)); }, 8000);
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.trim());
      if (line) {
        clearTimeout(timer);
        child.kill();
        try { resolve(JSON.parse(line)); } catch (e) { reject(e as Error); }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(INIT + '\n');
  });
}

describe('mcpb bridge bootstrap — starts under both launch shapes (0.11.34 boot bug)', () => {
  let stub: { url: string; close: () => Promise<void> };
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });

  test('launched as `node server.js` (require.main === module) answers initialize', async () => {
    const res = await bootAndInitialize([SERVER], stub.url);
    expect(res.id).toBe(0);
    expect((res as { result?: unknown }).result).toBeDefined();
  }, 12000);

  test('launched as a non-main require (Desktop-style loader) answers initialize', async () => {
    const requireExpr = `require(${JSON.stringify(SERVER)})`;
    const res = await bootAndInitialize(['-e', requireExpr], stub.url);
    expect(res.id).toBe(0);
    expect((res as { result?: unknown }).result).toBeDefined();
  }, 12000);
});
