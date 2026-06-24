/**
 * Regression harness for the SSE notification-stream socket timeout (#221).
 *
 * `GET /mcp` opens the standalone SSE notification stream, which is long-lived
 * and idle by design (this server pushes no server-initiated notifications).
 * The server-wide 120s idle socket timeout (configured in start()) would reap
 * that stream every ~2 min, surfacing as "stream terminated" reconnect churn in
 * bridges and noisy logs. handleMCPRequest now exempts only the GET (SSE)
 * socket from the idle timeout; POST request sockets keep the default.
 *
 * These assertions check the per-socket exemption directly — they return before
 * any SDK transport work, so they're deterministic without driving the SDK
 * transport in jsdom.
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

function makeReq(method: string, body: unknown, sessionId?: string) {
  const socket = { setTimeout: jest.fn() };
  const req = {
    method,
    body,
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    socket,
  };
  return { req, socket };
}

describe('SSE notification-stream socket timeout exemption (#221)', () => {
  let server: MCPHttpServer;

  beforeEach(() => {
    const mockApp = new App();
    mockApp.vault = {
      ...mockApp.vault,
      adapter: { basePath: '/mock/vault/path' }
    } as any;
    server = new MCPHttpServer(mockApp, 3001);
  });

  test('GET /mcp (SSE stream) disables its socket idle timeout', async () => {
    const { req, socket } = makeReq('GET', undefined, 'some-session');
    await (server as any).handleMCPRequest(req, makeRes());
    expect(socket.setTimeout).toHaveBeenCalledWith(0);
  });

  test('POST /mcp leaves the socket on the server-wide default timeout', async () => {
    const { req, socket } = makeReq('POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, 'some-session');
    await (server as any).handleMCPRequest(req, makeRes());
    expect(socket.setTimeout).not.toHaveBeenCalled();
  });

  test('exemption tolerates a missing socket (no throw)', async () => {
    const req = { method: 'GET', body: undefined, headers: {} as Record<string, string> };
    const res = makeRes();
    await expect((server as any).handleMCPRequest(req, res)).resolves.toBeUndefined();
  });
});
