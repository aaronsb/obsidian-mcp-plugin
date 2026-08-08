/**
 * Tool enumeration is live, and a change is announced (#285).
 *
 * The pool used to compute `availableTools` once per session and close over it
 * in both handlers, so a session's tool surface was frozen at creation:
 * toggling a tool off left every live session advertising it, and toggling one
 * on left agents unable to see it, until eviction or a client reconnect. This
 * is the stale-snapshot shape ADR-108 removed from permission state, in the
 * sibling control.
 *
 * Both halves are asserted, because either alone is insufficient: a
 * notification is pointless if the re-fetch returns the same frozen list, and a
 * live list is invisible if nobody is told to ask again.
 *
 * The pool is driven through its real handlers — a fake transport records what
 * the session would send — rather than asserting on internals.
 */
import { MCPServerPool } from '../../src/utils/mcp-server-pool';
import { SecureObsidianAPI } from '../../src/security';
import { BASELINE_SECURITY_SETTINGS } from '../../src/mcp-server';
import { App } from 'obsidian';

jest.mock('obsidian');

const makeApp = (): App => ({
  vault: {
    adapter: { basePath: '/test/vault' },
    getAbstractFileByPath: () => null,
    getFiles: () => [],
    getMarkdownFiles: () => []
  },
  metadataCache: { getFileCache: () => null, resolvedLinks: {} },
  workspace: { getActiveFile: () => null }
} as unknown as App);

/** Plugin double whose settings are mutated between calls, like the real UI. */
const makePlugin = (settings: Record<string, unknown>) => ({
  settings,
  manifest: { dir: '/test/vault/.obsidian/plugins/semantic-vault-mcp' }
});

interface ListToolsResult {
  tools: { name: string; inputSchema: { properties: { action: { enum: string[] } } } }[];
}

const systemActions = async (pool: MCPServerPool, sessionId: string): Promise<string[]> => {
  // Reach the registered ListTools handler the way a client would: through the
  // server the pool hands out for this session. The SDK wraps handlers so the
  // result is a promise even though ours is synchronous.
  const server = pool.getOrCreateServer(sessionId);
  const handlers = (server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<ListToolsResult>>
  })._requestHandlers;
  const listTools = handlers.get('tools/list');
  if (!listTools) throw new Error('tools/list handler not registered');
  const result = await listTools({ method: 'tools/list', params: {} }, {});
  const system = result.tools.find(t => t.name === 'system');
  return system ? system.inputSchema.properties.action.enum : [];
};

const makePool = (settings: Record<string, unknown>) => {
  const app = makeApp();
  const plugin = makePlugin(settings);
  const api = new SecureObsidianAPI(app, undefined, plugin, BASELINE_SECURITY_SETTINGS);
  return { pool: new MCPServerPool(api, 8, plugin), settings };
};

describe('tool list liveness', () => {
  it('reflects an enableWebFetch change on an EXISTING session, with no reconnect', async () => {
    const { pool, settings } = makePool({ enableWebFetch: false, toolVisibility: {} });

    expect(await systemActions(pool, 'session-a')).toEqual(['info', 'commands']);

    // The settings tab mutates the same object the plugin holds.
    settings.enableWebFetch = true;

    expect(await systemActions(pool, 'session-a')).toEqual(['info', 'commands', 'fetch_web']);

    settings.enableWebFetch = false;
    expect(await systemActions(pool, 'session-a')).toEqual(['info', 'commands']);
  });

  it('reflects a tool-visibility change on an existing session', async () => {
    const { pool, settings } = makePool({ enableWebFetch: false, toolVisibility: {} });

    expect(await systemActions(pool, 'session-b')).toContain('commands');

    (settings.toolVisibility as Record<string, boolean>)['system.commands'] = false;

    expect(await systemActions(pool, 'session-b')).not.toContain('commands');
  });

  describe('notifyToolListChanged', () => {
    /** Stand in for a session's transport state and capture what it sent. */
    const stubSession = (
      pool: MCPServerPool,
      id: string,
      opts: { connected?: boolean; send?: () => Promise<void> } = {}
    ) => {
      const server = pool.getOrCreateServer(id);
      const w = server as unknown as {
        isConnected: () => boolean;
        server: { sendToolListChanged: () => Promise<void> };
      };
      w.isConnected = () => opts.connected ?? true;
      if (opts.send) w.server.sendToolListChanged = opts.send;
      return w;
    };

    it('notifies every live session', () => {
      const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
      const sent: string[] = [];

      for (const id of ['s1', 's2', 's3']) {
        stubSession(pool, id, { send: () => { sent.push(id); return Promise.resolve(); } });
      }

      pool.notifyToolListChanged();
      expect(sent).toEqual(['s1', 's2', 's3']);
    });

    it('skips sessions with no live transport', () => {
      const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
      const sent: string[] = [];

      stubSession(pool, 'live', { send: () => { sent.push('live'); return Promise.resolve(); } });
      stubSession(pool, 'dead', {
        connected: false,
        send: () => { sent.push('dead'); return Promise.resolve(); }
      });

      pool.notifyToolListChanged();
      expect(sent).toEqual(['live']);
    });

    it('keeps going when one session throws synchronously', () => {
      // A settings toggle is a UI action, not a transaction: one dead session
      // must not deprive the others of the notification.
      const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
      const sent: string[] = [];

      for (const id of ['ok-1', 'boom', 'ok-2']) {
        stubSession(pool, id, {
          send: () => {
            if (id === 'boom') throw new Error('transport gone');
            sent.push(id);
            return Promise.resolve();
          }
        });
      }

      expect(() => pool.notifyToolListChanged()).not.toThrow();
      expect(sent).toEqual(['ok-1', 'ok-2']);
    });

    it('handles a transport that REJECTS rather than throwing', async () => {
      // The realistic failure: the send is async, so a half-dead socket rejects
      // later. A try/catch alone never sees it and node reports an unhandled
      // rejection. Nothing may escape to the process.
      const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        stubSession(pool, 'rejects', { send: () => Promise.reject(new Error('socket closed')) });
        stubSession(pool, 'fine', { send: () => Promise.resolve() });

        expect(() => pool.notifyToolListChanged()).not.toThrow();
        // Let any unhandled rejection surface before asserting none did.
        await new Promise(resolve => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('is a no-op with no sessions', () => {
      const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
      expect(() => pool.notifyToolListChanged()).not.toThrow();
    });
  });

  it('declares the listChanged capability so clients honour the notification', () => {
    const { pool } = makePool({ enableWebFetch: false, toolVisibility: {} });
    const server = pool.getOrCreateServer('cap');
    const caps = (server.server as unknown as {
      _capabilities: { tools?: { listChanged?: boolean } }
    })._capabilities;
    expect(caps.tools?.listChanged).toBe(true);
  });
});
