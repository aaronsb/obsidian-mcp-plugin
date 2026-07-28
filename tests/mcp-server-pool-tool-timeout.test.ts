/**
 * Regression harness for the tool-call timeout (#268): a hung tool handler
 * (e.g. a third-party plugin API stuck on an unready index) previously left
 * the JSON-RPC `tools/call` request pending forever, with no client-visible
 * error, because nothing bounded `await tool.handler(...)` and the server's
 * socket idle timeout does not reliably cover an already-open SSE response
 * that is waiting on that same promise (see mcp-server-pool.ts).
 *
 * Drives the real registered `CallToolRequestSchema` handler end to end
 * through an in-memory MCP transport pair (server side built by
 * `MCPServerPool.getOrCreateServer`, exactly as production code builds it),
 * so this exercises the actual dispatch path rather than re-implementing it.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { App } from 'obsidian';
import { MCPServerPool } from '../src/utils/mcp-server-pool';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { TOOL_CALL_TIMEOUT_MS } from '../src/utils/mcp-server-pool';
import type { SemanticTool } from '../src/tools/semantic-tools';

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

// Replace the real semantic tool set with a small, fully controllable one so
// this test exercises only the timeout wrapper, not vault/router behavior.
let hangHandler: jest.Mock;
let okHandler: jest.Mock;

jest.mock('../src/tools/semantic-tools', () => ({
  createSemanticTools: () => [
    {
      name: 'ok',
      description: 'resolves immediately',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: (...args: unknown[]) => okHandler(...args)
    },
    {
      name: 'hang',
      description: 'never resolves',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: (...args: unknown[]) => hangHandler(...args)
    }
  ] satisfies SemanticTool[]
}));

async function connectedClient(pool: MCPServerPool, sessionId: string) {
  const mcpServer = pool.getOrCreateServer(sessionId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('MCPServerPool tool-call timeout (#268)', () => {
  let mockApp: App;
  let pool: MCPServerPool;

  beforeEach(() => {
    mockApp = new App();
    mockApp.vault = {
      ...mockApp.vault,
      adapter: { basePath: '/mock/vault/path' }
    } as any;

    okHandler = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'fine' }] });
    hangHandler = jest.fn(() => new Promise(() => { /* never resolves */ }));

    const obsidianAPI = new ObsidianAPI(mockApp);
    pool = new MCPServerPool(obsidianAPI, 32);
  });

  afterEach(() => {
    pool.shutdown();
  });

  test('a tool that resolves quickly is unaffected by the timeout guard', async () => {
    const client = await connectedClient(pool, 'session-ok');
    const result = await client.callTool({ name: 'ok', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'fine' }]);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  test('an unknown tool name still returns the pre-existing not-found error, untouched by the timeout guard', async () => {
    const client = await connectedClient(pool, 'session-unknown');
    const result = await client.callTool({ name: 'does-not-exist', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('Unknown tool "does-not-exist"');
  });

  test('a tool handler that never resolves fails fast with a clear error instead of hanging forever', async () => {
    jest.useFakeTimers();
    try {
      const client = await connectedClient(pool, 'session-hang');
      const callPromise = client.callTool({ name: 'hang', arguments: {} });

      // Negative check: just before the deadline, nothing has settled yet —
      // this is not a zero-delay stub, it genuinely waits out the window.
      await jest.advanceTimersByTimeAsync(TOOL_CALL_TIMEOUT_MS - 10);
      let settled = false;
      void callPromise.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      // Positive check: crossing the deadline resolves the call with a clean,
      // client-visible error rather than leaving it pending.
      await jest.advanceTimersByTimeAsync(10);
      const result = await callPromise;
      expect(result.isError).toBe(true);
      const message = (result.content as Array<{ text: string }>)[0].text;
      expect(message).toContain('hang');
      expect(message).toContain('timed out');
      expect(hangHandler).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a session that just timed out on one call still serves the next call normally (server/session stay healthy)', async () => {
    jest.useFakeTimers();
    try {
      const client = await connectedClient(pool, 'session-recover');

      const hungCall = client.callTool({ name: 'hang', arguments: {} });
      await jest.advanceTimersByTimeAsync(TOOL_CALL_TIMEOUT_MS);
      const hungResult = await hungCall;
      expect(hungResult.isError).toBe(true);

      const okResult = await client.callTool({ name: 'ok', arguments: {} });
      expect(okResult.isError).toBeFalsy();
      expect(okResult.content).toEqual([{ type: 'text', text: 'fine' }]);
    } finally {
      jest.useRealTimers();
    }
  });
});
