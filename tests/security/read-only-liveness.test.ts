/**
 * Read-only mode takes effect immediately, in both directions (ADR-108).
 *
 * The reported bypass was that `edit` wrote to disk with Read-only mode on. The
 * cause was not the tool layer's `operation === 'vault'` narrowness but a STALE
 * ruleset: the security layer chose presets.readOnly() once, in the server
 * constructor, while the tool-layer guard read the setting live. Toggling on a
 * running server therefore refused `vault.create` and allowed `edit.append` —
 * while the settings notice claimed all writes were blocked.
 *
 * These tests construct the API in one state and flip the setting WITHOUT
 * rebuilding anything, which is exactly what the settings toggle does.
 */
import { SecureObsidianAPI } from '../../src/security';
import { createSemanticTools } from '../../src/tools/semantic-tools';
import { BASELINE_SECURITY_SETTINGS } from '../../src/mcp-server';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

type Write = { op: string; path: string };

function mkFile(p: string): TFile {
  const f = new TFile();
  const w = f as unknown as { path: string; extension: string; name: string };
  w.path = p;
  w.extension = 'md';
  w.name = p;
  return f;
}

function makeApp(writes: Write[]): App {
  return {
    vault: {
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (p === 'note.md' ? mkFile(p) : null),
      read: async () => 'body\n',
      cachedRead: async () => 'body\n',
      modify: async (f: TFile) => { writes.push({ op: 'modify', path: f.path }); },
      create: async (p: string) => { writes.push({ op: 'create', path: p }); return mkFile(p); },
      getFiles: () => [mkFile('note.md')],
    },
    fileManager: {
      renameFile: async (_f: TFile, n: string) => { writes.push({ op: 'rename', path: n }); },
      trashFile: async (f: TFile) => { writes.push({ op: 'trash', path: f.path }); },
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => mkFile('note.md') },
  } as unknown as App;
}

/** Mutable settings object, as the real plugin holds. */
function setup(readOnlyMode: boolean) {
  const writes: Write[] = [];
  const plugin = { settings: { readOnlyMode } };
  const api = new SecureObsidianAPI(makeApp(writes), undefined, plugin as never);
  const tools = createSemanticTools(api)!;
  return {
    writes,
    plugin,
    vault: tools.find(t => t.name === 'vault')!,
    edit: tools.find(t => t.name === 'edit')!,
    bases: tools.find(t => t.name === 'bases')!,
    api,
  };
}

describe('read-only mode liveness', () => {
  it('blocks edit.append the moment it is switched ON, with no restart', async () => {
    const s = setup(false);

    // Baseline: writes work.
    await s.edit.handler(s.api, { action: 'append', path: 'note.md', content: 'x' });
    expect(s.writes.length).toBe(1);

    // The settings toggle. Nothing is reconstructed.
    s.plugin.settings.readOnlyMode = true;

    const res = await s.edit.handler(s.api, { action: 'append', path: 'note.md', content: 'y' });

    // Still 1 — the second append did not reach the vault. This is the exact
    // case that previously returned "Edit successful" and modified the file.
    expect(s.writes.length).toBe(1);
    expect(JSON.stringify(res)).toContain('READ_ONLY_MODE');
  });

  it('allows writes again the moment it is switched OFF, with no restart', async () => {
    const s = setup(true);

    await s.edit.handler(s.api, { action: 'append', path: 'note.md', content: 'x' });
    expect(s.writes).toEqual([]);

    // Disabling had the mirror-image bug: writes stayed blocked until restart.
    s.plugin.settings.readOnlyMode = false;

    await s.edit.handler(s.api, { action: 'append', path: 'note.md', content: 'y' });
    expect(s.writes.length).toBe(1);
  });

  it('covers vault and bases too, not just edit', async () => {
    const s = setup(false);
    s.plugin.settings.readOnlyMode = true;

    await s.vault.handler(s.api, { action: 'create', path: 'new.md', content: 'x' });
    await s.bases.handler(s.api, {
      action: 'create', path: 'new.base', config: { views: [{ type: 'table', name: 'v' }] },
    });
    await s.vault.handler(s.api, {
      action: 'move', path: 'note.md', destination: 'moved.md',
    });

    expect(s.writes).toEqual([]);
  });

  /**
   * The quadrant that shipped broken.
   *
   * The other cases build the API without an explicit snapshot, so it defaults to
   * DEFAULT_SECURITY_SETTINGS (all permissions true) and the OFF direction passes
   * for free — the predicate only ever ADDS denial. Production was different:
   * mcp-server.ts installed presets.readOnly() when the server booted with
   * read-only on, and no predicate returning false can undo an all-false
   * snapshot. Toggling off left every write denied until restart.
   *
   * Passing presets.readOnly() explicitly reproduces a read-only boot. This must
   * hold for the user who runs read-only by default and flips it off for one edit.
   */
  it('re-allows writes after a read-only BOOT, using the shipped baseline', async () => {
    const writes: Write[] = [];
    const plugin = { settings: { readOnlyMode: true } };
    // Exactly what mcp-server.ts builds every API with, read-only or not.
    const api = new SecureObsidianAPI(
      makeApp(writes), undefined, plugin as never, BASELINE_SECURITY_SETTINGS,
    );
    const edit = createSemanticTools(api)!.find(t => t.name === 'edit')!;

    await edit.handler(api, { action: 'append', path: 'note.md', content: 'x' });
    expect(writes).toEqual([]);

    plugin.settings.readOnlyMode = false;

    await edit.handler(api, { action: 'append', path: 'note.md', content: 'y' });
    expect(writes.length).toBe(1);
  });

  /**
   * The invariant that makes the case above work, stated directly.
   *
   * The predicate can only ADD denial, never grant, so a restrictive baseline is
   * a one-way door — and that is correct, since a user who configures restrictive
   * permissions should not have them loosened by a read-only toggle. The
   * consequence is that the baseline itself must stay permissive. mcp-server.ts
   * previously installed presets.readOnly() when booting read-only, which is why
   * toggling read-only off required a restart.
   */
  it('ships a permissive baseline, so read-only is the only thing denying', () => {
    expect(BASELINE_SECURITY_SETTINGS.permissions).toEqual({
      read: true, create: true, update: true,
      delete: true, move: true, rename: true, execute: true,
    });
    // Path validation is not a permission and must stay on regardless.
    expect(BASELINE_SECURITY_SETTINGS.pathValidation).toBe('strict');
  });

  it('confirms a restrictive baseline is NOT undone by the predicate', async () => {
    // Documents the one-way door rather than asserting it away: this is why the
    // baseline above must never be restrictive.
    const writes: Write[] = [];
    const plugin = { settings: { readOnlyMode: true } };
    const api = new SecureObsidianAPI(
      makeApp(writes), undefined, plugin as never,
      { permissions: { read: true, create: false, update: false, delete: false, move: false, rename: false, execute: false } },
    );
    const edit = createSemanticTools(api)!.find(t => t.name === 'edit')!;

    plugin.settings.readOnlyMode = false;
    await edit.handler(api, { action: 'append', path: 'note.md', content: 'y' });

    expect(writes).toEqual([]);
  });

  /**
   * The path real MCP clients take. MCPServerPool.createPooledServer builds each
   * session's API with BOTH the plugin ref and a *snapshot* of the parent's
   * security settings (`getSecuritySettings()`), captured when the server was
   * constructed. If that snapshot won over the live predicate, every session
   * would keep enforcing the state read-only had at server start — reproducing
   * the original bug for exactly the callers that matter.
   */
  it('live predicate beats the settings snapshot a session API is built with', async () => {
    const writes: Write[] = [];
    const plugin = { settings: { readOnlyMode: false } };

    // Permissive snapshot, as taken when read-only was off at construction.
    const permissiveSnapshot = {
      pathValidation: 'strict' as const,
      permissions: {
        read: true, create: true, update: true,
        delete: true, move: true, rename: true, execute: true,
      },
      blockedPaths: [],
      logSecurityEvents: false,
    };

    const sessionApi = new SecureObsidianAPI(
      makeApp(writes), undefined, plugin as never, permissiveSnapshot,
    );
    const edit = createSemanticTools(sessionApi)!.find(t => t.name === 'edit')!;

    plugin.settings.readOnlyMode = true;

    await edit.handler(sessionApi, { action: 'append', path: 'note.md', content: 'x' });

    expect(writes).toEqual([]);
  });

  it('never blocks reads', async () => {
    const s = setup(true);

    const res = await s.vault.handler(s.api, { action: 'read', path: 'note.md' });

    const text = JSON.stringify(res);
    expect(text).not.toContain('READ_ONLY_MODE');
    expect(text).not.toContain('PERMISSION_DENIED');
  });
});
