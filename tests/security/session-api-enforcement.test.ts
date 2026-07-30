/**
 * Sessions must get real enforcement, not just the parent API.
 *
 * Real MCP clients never touch the API the server constructs directly — they get
 * a per-session SecureObsidianAPI built inside
 * MCPServerPool.createPooledServer, captured in a closure with no registry
 * exposing it. Two assumptions hold read-only together for those clients, and
 * neither was covered by a test:
 *
 *   1. the pool passes the live plugin reference, so the read-only predicate has
 *      a setting to read (without it, read-only silently does not apply)
 *   2. the pool never builds an unsecured session API
 *
 * Both previously rested on reading the code. If someone changed the pool to
 * pass a derived settings object, or omitted the plugin, the other liveness
 * tests would still pass while production regressed to the original bug.
 */
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

/**
 * Wrap SecureObsidianAPI so constructor arguments can be inspected. The pool
 * imports from this exact specifier, so it receives the wrapper, and the
 * `instanceof` check inside the pool still works because the wrapper extends
 * the real class.
 */
const constructorCalls: unknown[][] = [];
jest.mock('../../src/security/secure-obsidian-api', () => {
  const actual = jest.requireActual('../../src/security/secure-obsidian-api');
  class Recording extends actual.SecureObsidianAPI {
    constructor(...args: unknown[]) {
      constructorCalls.push(args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- forwarding the real signature verbatim
      super(...(args as Parameters<typeof actual.SecureObsidianAPI>));
    }
  }
  return { ...actual, SecureObsidianAPI: Recording };
});

// Imported after the mock so the pool binds to the wrapper.
import { MCPServerPool } from '../../src/utils/mcp-server-pool';
import { SecureObsidianAPI } from '../../src/security/secure-obsidian-api';
import { ObsidianAPI } from '../../src/utils/obsidian-api';
import { BASELINE_SECURITY_SETTINGS } from '../../src/mcp-server';

function mkFile(p: string): TFile {
  const f = new TFile();
  const w = f as unknown as { path: string; extension: string; name: string };
  w.path = p;
  w.extension = 'md';
  w.name = p;
  return f;
}

function makeApp(): App {
  return {
    vault: {
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (p === 'note.md' ? mkFile(p) : null),
      read: async () => 'body\n',
      cachedRead: async () => 'body\n',
      modify: async () => undefined,
      create: async (p: string) => mkFile(p),
      getFiles: () => [mkFile('note.md')],
    },
    fileManager: { renameFile: async () => undefined, trashFile: async () => undefined },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => mkFile('note.md') },
  } as unknown as App;
}

describe('session API enforcement', () => {
  beforeEach(() => { constructorCalls.length = 0; });

  it('hands each session the live plugin reference, by identity', () => {
    const app = makeApp();
    const plugin = { settings: { readOnlyMode: false } };
    const parent = new SecureObsidianAPI(app, undefined, plugin as never, BASELINE_SECURITY_SETTINGS);

    const pool = new MCPServerPool(parent, 4, plugin as never);
    constructorCalls.length = 0;   // ignore the parent's own construction
    pool.getOrCreateServer('session-1');

    expect(constructorCalls.length).toBeGreaterThan(0);
    const [, , sessionPlugin] = constructorCalls[0];
    // Identity, not shape: a copy would read stale settings after a toggle, which
    // is precisely the staleness ADR-108 removed.
    expect(sessionPlugin).toBe(plugin);
  });

  it('refuses to build a session without the security layer', () => {
    const app = makeApp();
    const plugin = { settings: { readOnlyMode: true } };
    // A plain ObsidianAPI used to make the pool fall back to an unsecured
    // session API and merely log "(no security)".
    const parent = new ObsidianAPI(app, undefined, plugin as never);

    const pool = new MCPServerPool(parent, 4, plugin as never);

    expect(() => pool.getOrCreateServer('session-2')).toThrow(/without the security layer/);
  });
});
