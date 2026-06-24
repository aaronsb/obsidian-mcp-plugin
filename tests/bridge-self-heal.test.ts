/**
 * Regression harness for #238: the .mcpb stdio bridge (mcpb/server.js) must
 * self-heal when the server evicts/loses a session.
 *
 * Before the fix, a 404 on a non-initialize call made the bridge clear its
 * session and emit `-32000 "please reinitialize"` to the client; clients that
 * ignore the signal (e.g. Claude Desktop) then sent the next tool call with no
 * session → HTTP 400 → the connection dead-ended until a manual restart.
 *
 * The bridge now caches the `initialize` handshake and, on a 404, transparently
 * re-initializes and replays the original message once, so recovery is
 * invisible to the client. These tests drive `dispatch` directly with a mocked
 * `fetch`, capturing what the bridge writes to stdout.
 */

// Must be set before the bridge module is required (it reads env at load).
process.env.MCP_URL = 'http://localhost:3001/mcp';
process.env.MCP_API_KEY = 'test-key';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- bridge is plain CommonJS, loaded as a module to test dispatch
const bridge = require('../mcpb/server.js') as {
  dispatch: (msg: unknown, isReplay?: boolean) => Promise<void>;
  __reset: () => void;
  __state: () => { sessionId: string | null; cachedInitialize: unknown };
};

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  text: () => Promise<string>;
  body: { cancel: () => Promise<void>; getReader: () => { read: () => Promise<{ done: boolean; value: undefined }> } };
}

function res(status: number, opts: { sid?: string; json?: unknown } = {}): FakeResponse {
  const h = new Map<string, string>();
  if (opts.sid) h.set('mcp-session-id', opts.sid);
  h.set('content-type', opts.json !== undefined ? 'application/json' : 'text/plain');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => (opts.json !== undefined ? JSON.stringify(opts.json) : ''),
    body: {
      cancel: async () => {},
      getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
    },
  };
}

interface FetchRecord { method: string; session?: string; rpc?: string; id?: unknown }

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const TOOL_CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault', arguments: { action: 'list' } } };

describe('mcpb bridge self-heal on session expiry (#238)', () => {
  let emitted: Array<Record<string, unknown>>;
  let calls: FetchRecord[];
  let writeSpy: jest.SpyInstance;

  function installFetch(impl: (rec: FetchRecord, opts: { method: string; headers?: Record<string, string>; body?: string }) => FakeResponse) {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, opts: { method: string; headers?: Record<string, string>; body?: string }) => {
      const session = opts.headers?.['Mcp-Session-Id'];
      if (opts.method === 'GET' || opts.method === 'DELETE') {
        calls.push({ method: opts.method, session });
        return res(200);
      }
      const msg = JSON.parse(opts.body as string) as { method: string; id?: unknown };
      const rec: FetchRecord = { method: opts.method, session, rpc: msg.method, id: msg.id };
      calls.push(rec);
      return impl(rec, opts);
    });
  }

  beforeEach(() => {
    bridge.__reset();
    emitted = [];
    calls = [];
    // emit() writes JSON + '\n' to stdout; capture and parse each line.
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) emitted.push(JSON.parse(line));
      }
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test('404 on a tool call → bridge re-initializes and replays, emitting the real result (not an error)', async () => {
    let sidSeq = 0;
    installFetch((rec) => {
      if (rec.rpc === 'initialize') {
        sidSeq += 1;
        return res(200, { sid: `sess-${sidSeq}`, json: { jsonrpc: '2.0', id: rec.id, result: { serverInfo: { name: 'x' } } } });
      }
      if (rec.rpc === 'notifications/initialized') return res(202);
      // First session (sess-1) is the evicted one; the replay uses sess-2.
      if (rec.session === 'sess-1') return res(404, { sid: 'sess-1', json: { jsonrpc: '2.0', id: rec.id, error: { code: -32001, message: 'expired' } } });
      return res(200, { json: { jsonrpc: '2.0', id: rec.id, result: { ok: true } } });
    });

    await bridge.dispatch(INIT);
    await bridge.dispatch(TOOL_CALL);

    // The client receives the genuine tool result, never the expiry error.
    const toolResult = emitted.find(m => m.id === 1);
    expect(toolResult).toBeDefined();
    expect((toolResult as { result?: { ok?: boolean } }).result?.ok).toBe(true);
    expect(emitted.some(m => (m as { error?: { code?: number } }).error?.code === -32000)).toBe(false);

    // It re-initialized once and replayed the tool call under the fresh session.
    const reinit = calls.filter(c => c.rpc === 'initialize');
    expect(reinit).toHaveLength(2);
    const toolCalls = calls.filter(c => c.rpc === 'tools/call');
    expect(toolCalls.map(c => c.session)).toEqual(['sess-1', 'sess-2']);
  });

  test('reinitialize itself fails → bridge surfaces a single -32000 and does not replay or loop', async () => {
    let initCount = 0;
    installFetch((rec) => {
      if (rec.rpc === 'initialize') {
        initCount += 1;
        // First handshake establishes sess-1; the self-heal handshake fails
        // (200 but no session id), so recovery must give up — not loop.
        if (initCount === 1) return res(200, { sid: 'sess-1', json: { jsonrpc: '2.0', id: rec.id, result: {} } });
        return res(200, { json: { jsonrpc: '2.0', id: rec.id, result: {} } });
      }
      if (rec.rpc === 'notifications/initialized') return res(202);
      return res(404, { sid: rec.session, json: { jsonrpc: '2.0', id: rec.id, error: { code: -32001, message: 'expired' } } });
    });

    await bridge.dispatch(INIT);
    await bridge.dispatch(TOOL_CALL);

    const err = emitted.find(m => m.id === 1) as { error?: { code?: number; message?: string } } | undefined;
    expect(err?.error?.code).toBe(-32000);
    expect(err?.error?.message).toMatch(/reinitialize failed/i);
    // Exactly one self-heal attempt: 2 initialize calls total, never a third.
    expect(calls.filter(c => c.rpc === 'initialize')).toHaveLength(2);
    // The original tool call was attempted once; the failed heal means no
    // successful replay, and the cap prevents a reinit loop.
    expect(calls.filter(c => c.rpc === 'tools/call')).toHaveLength(1);
  });

  test('initialize handshake is cached so a later session loss can be replayed', async () => {
    installFetch((rec) => {
      if (rec.rpc === 'initialize') return res(200, { sid: 'sess-1', json: { jsonrpc: '2.0', id: rec.id, result: {} } });
      return res(200, { json: { jsonrpc: '2.0', id: rec.id, result: {} } });
    });

    expect(bridge.__state().cachedInitialize).toBeNull();
    await bridge.dispatch(INIT);
    expect(bridge.__state().cachedInitialize).toMatchObject({ method: 'initialize' });
    expect(bridge.__state().sessionId).toBe('sess-1');
  });
});
