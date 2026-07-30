/**
 * Tool visibility gating (ADR-101) — previously zero coverage, despite being
 * relied on as a containment boundary.
 *
 * The reporter of the read-only bypass configured `edit` and `bases.create` off
 * via Tool visibility and ran that as their effectively-read-only setup. That
 * makes this a security control in practice, so it is tested like one: the
 * assertions are on RECORDED VAULT WRITES, not on whether a tool appears in a
 * list. A hidden tool that still writes when invoked is not a boundary.
 *
 * Two layers exist and both are checked:
 *   1. enumeration — a disabled operation/action is not advertised
 *   2. dispatch    — a disabled action is refused even when invoked directly,
 *                    which is what matters, since a client can call an action
 *                    that was never advertised
 */
import { SecureObsidianAPI } from '../../src/security';
import { createSemanticTools, getActionsForOperation } from '../../src/tools/semantic-tools';
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

/** The advertised action enum from a tool's input schema. */
function advertisedActions(tool: { inputSchema: unknown }): string[] {
  const schema = tool.inputSchema as unknown as {
    properties: { action: { enum: string[] } };
  };
  return schema.properties.action.enum;
}

function setup(visibility?: Record<string, boolean>) {
  const writes: Write[] = [];
  // Read-only OFF and permissions permissive on purpose: visibility must stand on
  // its own, not be propped up by another control.
  const plugin = { settings: { readOnlyMode: false } };
  const api = new SecureObsidianAPI(
    makeApp(writes), undefined, plugin as never, BASELINE_SECURITY_SETTINGS,
  );
  const tools = createSemanticTools(api, visibility) ?? [];
  return { writes, api, tools, byName: (n: string) => tools.find(t => t.name === n) };
}

describe('tool visibility gating', () => {
  describe('enumeration', () => {
    it('advertises every operation when no visibility is configured', () => {
      const { tools } = setup(undefined);
      expect(tools.map(t => t.name)).toEqual(
        expect.arrayContaining(['vault', 'edit', 'view', 'workflow', 'system', 'graph', 'bases']),
      );
    });

    it('omits an operation disabled at the operation level', () => {
      const { byName } = setup({ edit: false });
      expect(byName('edit')).toBeUndefined();
      expect(byName('vault')).toBeDefined();
    });

    it('omits a disabled action from the advertised enum', () => {
      const { byName } = setup({ 'bases.create': false });
      const bases = byName('bases')!;
      const advertised = advertisedActions(bases);

      expect(advertised).not.toContain('create');
      expect(advertised).toContain('read');
    });

    it('omits the whole operation when every one of its actions is disabled', () => {
      const allEditOff = Object.fromEntries(
        getActionsForOperation('edit').map(a => [`edit.${a}`, false]),
      );
      const { byName } = setup(allEditOff);
      expect(byName('edit')).toBeUndefined();
    });

    it('leaves an operation advertised when only some actions are disabled', () => {
      const { byName } = setup({ 'edit.append': false });
      const edit = byName('edit')!;
      const advertised = advertisedActions(edit);

      expect(advertised).not.toContain('append');
      expect(advertised).toContain('window');
    });
  });

  /**
   * The layer that actually contains anything. Enumeration is advisory — nothing
   * stops a client sending an action it was never offered.
   */
  describe('dispatch enforcement', () => {
    it('refuses a disabled action invoked directly, and records no write', async () => {
      const { byName, api, writes } = setup({ 'edit.append': false });
      const edit = byName('edit')!;

      const res = await edit.handler(api, { action: 'append', path: 'note.md', content: 'x' });

      expect(JSON.stringify(res)).toContain('ACTION_DISABLED');
      expect(writes).toEqual([]);
    });

    it('still allows a sibling action on the same operation', async () => {
      const { byName, api, writes } = setup({ 'edit.append': false });
      const edit = byName('edit')!;

      await edit.handler(api, { action: 'window', path: 'note.md', oldText: 'body', newText: 'z' });

      expect(writes.length).toBeGreaterThan(0);
    });

    it('refuses bases.create and records no write', async () => {
      const { byName, api, writes } = setup({ 'bases.create': false });
      const bases = byName('bases')!;

      const res = await bases.handler(api, {
        action: 'create', path: 'x.base', config: { views: [{ type: 'table', name: 'v' }] },
      });

      expect(JSON.stringify(res)).toContain('ACTION_DISABLED');
      expect(writes).toEqual([]);
    });
  });

  /**
   * The reporter's actual configuration, asserted end to end. If this ever
   * regresses, someone running it as their containment boundary loses that
   * boundary silently.
   */
  describe("the reporter's read-only-by-visibility configuration", () => {
    const config = { edit: false, 'bases.create': false };

    it('leaves no reachable write path through edit or bases.create', async () => {
      const { byName, api, writes } = setup(config);

      expect(byName('edit')).toBeUndefined();

      const bases = byName('bases')!;
      await bases.handler(api, {
        action: 'create', path: 'x.base', config: { views: [{ type: 'table', name: 'v' }] },
      });

      expect(writes).toEqual([]);
    });

    it('does NOT block vault writes — visibility is per-action, not a read-only mode', async () => {
      // Worth pinning explicitly: this configuration is not equivalent to
      // read-only. vault.create is untouched by it and still writes. Anyone
      // relying on the visibility toggles for containment has to disable the
      // vault write actions too.
      const { byName, api, writes } = setup(config);

      await byName('vault')!.handler(api, { action: 'create', path: 'new.md', content: 'x' });

      expect(writes.length).toBeGreaterThan(0);
    });
  });

  describe('truthiness handling', () => {
    it('treats only an explicit false as disabled', () => {
      // `visibility[key] !== false` is the shipped check; a missing or true entry
      // must leave the action enabled rather than defaulting to hidden.
      const { byName } = setup({ 'edit.append': true });
      const advertised = advertisedActions(byName('edit')!);

      expect(advertised).toContain('append');
    });
  });
});
