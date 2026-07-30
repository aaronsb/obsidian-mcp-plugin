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

  it('never blocks reads', async () => {
    const s = setup(true);

    const res = await s.vault.handler(s.api, { action: 'read', path: 'note.md' });

    const text = JSON.stringify(res);
    expect(text).not.toContain('READ_ONLY_MODE');
    expect(text).not.toContain('PERMISSION_DENIED');
  });
});
