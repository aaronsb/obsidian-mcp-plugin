/**
 * Regression harness for #190 / #128 (ADR-106): client-driven session
 * re-initialization via the spec-compliant HTTP 404 signal.
 *
 * The pre-ADR-106 server tried a server-side synthetic `initialize` for an
 * evicted session, which cannot drive SDK 1.29's web-standard transport to an
 * initialized state, "failed open," and returned a non-spec
 * `400 -32000 "Server not initialized"` that no client treats as a
 * session-expiry signal — an unrecoverable loop until client restart.
 *
 * ADR-106: a non-`initialize` request bearing an evicted `Mcp-Session-Id`
 * must return HTTP 404 with the `Mcp-Session-Id` echoed (spec §3) so a
 * compliant client/bridge re-initializes per §4; a non-`initialize` request
 * with no session id must return HTTP 400 (spec §2); an `initialize` request
 * must never be short-circuited as "terminated".
 *
 * These paths return before any SDK transport is constructed, so they are
 * deterministic without exercising the SDK transport in jsdom (the exact
 * thing #190 established cannot be driven synthetically).
 */
import { MCPHttpServer } from '../src/mcp-server';
import { App } from 'obsidian';

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
  setHeader: (k: string, v: string) => void;
  status: (c: number) => MockRes;
  json: (b: unknown) => void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; }
  };
  return res;
}

function makeReq(body: unknown, sessionId?: string) {
  return {
    body,
    headers: sessionId ? { 'mcp-session-id': sessionId } : {}
  };
}

describe('MCP session re-initialization signal (ADR-106 / #190 / #128)', () => {
  let server: MCPHttpServer;

  beforeEach(() => {
    const mockApp = new App();
    mockApp.vault = {
      ...mockApp.vault,
      adapter: { basePath: '/mock/vault/path' }
    } as any;
    server = new MCPHttpServer(mockApp, 3001);
  });

  test('evicted session + non-initialize request → HTTP 404 with Mcp-Session-Id echoed (spec §3)', async () => {
    const res = makeRes();
    const staleSession = 'stale-session-id-1234';
    // No transport is registered for this id → evicted/terminated.
    await (server as any).handleMCPRequest(
      makeReq({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }, staleSession),
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.headers['mcp-session-id']).toBe(staleSession);
    // Must NOT be the old unrecoverable non-spec signal.
    expect(res.statusCode).not.toBe(400);
    const body = res.body as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toMatch(/initialize/i);
  });

  test('non-initialize request with no session id → HTTP 400 (spec §2)', async () => {
    const res = makeRes();
    await (server as any).handleMCPRequest(
      makeReq({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  test('initialize request is never short-circuited as a terminated session', async () => {
    const spy = jest.spyOn(server as any, 'sendSessionTerminated');

    // (a) initialize with no session id (fresh) and (b) initialize bearing a
    // stale session id (recreate path) must both bypass the 404/400 signal.
    for (const sid of [undefined, 'previously-evicted-id']) {
      const res = makeRes();
      await (server as any).handleMCPRequest(
        makeReq(
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
          sid
        ),
        res
      );
      expect(res.statusCode).not.toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('sendSessionTerminated emits the spec signals directly', () => {
    const withId = makeRes();
    (server as any).sendSessionTerminated(withId, { id: 3 }, 'sess-abc');
    expect(withId.statusCode).toBe(404);
    expect(withId.headers['mcp-session-id']).toBe('sess-abc');
    expect((withId.body as { id?: unknown }).id).toBe(3);

    const noId = makeRes();
    (server as any).sendSessionTerminated(noId, { id: null }, undefined);
    expect(noId.statusCode).toBe(400);
    expect(noId.headers['mcp-session-id']).toBeUndefined();
  });
});
