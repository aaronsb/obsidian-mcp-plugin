/**
 * #326: `vault.replace` is the name for what `vault.update` always did —
 * replace the entire file contents. Two callers wiped files with `update`
 * because the name reads like a partial modification.
 *
 * `update` stays as a deprecated alias: same behaviour, plus a notice in the
 * response pointing at `replace` and the edit tool. The alias must not be a
 * weaker door than `replace`, nor `replace` a weaker door than `update`, so
 * each protection `update` had is asserted here for `replace` as well.
 *
 * Assertions are on recorded vault writes, following tool-visibility.test.ts.
 */
import { SecureObsidianAPI, SecurityError, VaultSecurityManager } from '../src/security';
import {
  applyVisibilityToggle, createSemanticTools, getOperationDescription,
  isActionVisible, visibilityRowValue, visibilityTreeActions,
} from '../src/tools/semantic-tools';
import { SemanticRouter } from '../src/semantic/router';
import { executeVaultOperation, VAULT_UPDATE_DEPRECATION } from '../src/semantic/operations/vault';
import { BASELINE_SECURITY_SETTINGS } from '../src/mcp-server';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

type Write = { op: string; path: string; content?: string };

const ORIGINAL = '# Title\n\nFirst section.\n\n## Second\n\nSecond section.\n';

function mkFile(p: string): TFile {
  const f = new TFile();
  const w = f as unknown as { path: string; extension: string; name: string };
  w.path = p;
  w.extension = 'md';
  w.name = p;
  return f;
}

/**
 * `resolveAll` makes every path resolve to a file, so a refusal can only come
 * from the security layer and not from "File not found".
 */
function makeApp(writes: Write[], resolveAll = false): App {
  return {
    vault: {
      configDir: '.obsidian', adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (resolveAll || p === 'note.md' ? mkFile(p) : null),
      read: async () => ORIGINAL,
      cachedRead: async () => ORIGINAL,
      modify: async (f: TFile, data: string) => { writes.push({ op: 'modify', path: f.path, content: data }); },
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

function setup(opts: { readOnly?: boolean; visibility?: Record<string, boolean>; resolveAll?: boolean } = {}) {
  const writes: Write[] = [];
  const plugin = { settings: { readOnlyMode: opts.readOnly === true } };
  const api = new SecureObsidianAPI(
    makeApp(writes, opts.resolveAll), undefined, plugin as never, BASELINE_SECURITY_SETTINGS,
  );
  const tools = createSemanticTools(api, opts.visibility) ?? [];
  return { writes, api, byName: (n: string) => tools.find(t => t.name === n) };
}

function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

function advertisedActions(tool: { inputSchema: unknown }): string[] {
  return (tool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
}

describe('vault.replace (#326)', () => {
  describe('behaviour', () => {
    it('writes the full new content over the file', async () => {
      const { byName, api, writes } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'replace', path: 'note.md', content: 'Entirely new body.\n',
      });

      expect((res as { isError?: boolean }).isError).toBeUndefined();
      expect(writes).toEqual([{ op: 'modify', path: 'note.md', content: 'Entirely new body.\n' }]);
      expect(text(res)).toContain('Replaced: note.md');
      expect(text(res)).not.toContain('deprecated');
    });

    it('rejects a missing content without writing, naming vault.replace', async () => {
      const { byName, api, writes } = setup();

      const res = await byName('vault')!.handler(api, { action: 'replace', path: 'note.md' });

      expect(text(res)).toContain("vault.replace requires 'content'");
      expect(writes).toEqual([]);
    });
  });

  describe('vault.update (deprecated alias)', () => {
    it('still replaces the file contents', async () => {
      const { byName, api, writes } = setup();

      await byName('vault')!.handler(api, {
        action: 'update', path: 'note.md', content: 'Entirely new body.\n',
      });

      expect(writes).toEqual([{ op: 'modify', path: 'note.md', content: 'Entirely new body.\n' }]);
    });

    it('carries the deprecation notice in the formatted response', async () => {
      const { byName, api } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'update', path: 'note.md', content: 'x',
      });

      expect(text(res)).toContain(VAULT_UPDATE_DEPRECATION);
      expect(text(res)).toContain('Updated: note.md');
    });

    it('carries the deprecation notice in the raw response', async () => {
      const { byName, api } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'update', path: 'note.md', content: 'x', raw: true,
      });
      const parsed = JSON.parse(text(res)) as { result: { deprecation?: string; success: boolean } };

      expect(parsed.result.deprecation).toBe(VAULT_UPDATE_DEPRECATION);
      expect(parsed.result.success).toBe(true);
    });

    it('states the notice the issue asked for', () => {
      expect(VAULT_UPDATE_DEPRECATION).toBe(
        '`vault.update` is deprecated — use `vault.replace` (replaces entire file contents) or `edit.window`/`edit.patch` for partial modifications.',
      );
    });
  });

  describe('protections replace shares with update', () => {
    it.each(['replace', 'update'])('read-only mode blocks vault.%s with a SecurityError', async (action) => {
      const writes: Write[] = [];
      const api = new SecureObsidianAPI(
        makeApp(writes), undefined, { settings: { readOnlyMode: true } } as never, BASELINE_SECURITY_SETTINGS,
      );
      const router = new SemanticRouter(api, api.getApp());

      await expect(
        executeVaultOperation(router, action, { path: 'note.md', content: 'x' }),
      ).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it.each(['replace', 'update'])('the read-only security preset blocks vault.%s', async (action) => {
      const writes: Write[] = [];
      const api = new SecureObsidianAPI(
        makeApp(writes), undefined, { settings: { readOnlyMode: false } } as never,
        VaultSecurityManager.presets.readOnly(),
      );
      const router = new SemanticRouter(api, api.getApp());

      await expect(
        executeVaultOperation(router, action, { path: 'note.md', content: 'x' }),
      ).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it.each(['replace', 'update'])('path validation refuses vault.%s outside the vault', async (action) => {
      // Every path resolves, so without the validator this call would write.
      const { byName, api, writes } = setup({ resolveAll: true });

      const res = await byName('vault')!.handler(api, {
        action, path: '../outside.md', content: 'x',
      });

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(text(res)).toContain('FORBIDDEN_PATTERN');
      expect(writes).toEqual([]);
    });

    it('rejects inapplicable parameters on vault.replace, and records no write', async () => {
      const { byName, api, writes } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'replace', path: 'note.md', content: 'x', mode: 'append', overwrite: false,
      });
      const { error } = JSON.parse(text(res)) as {
        error: { code: string; message: string; rejected: { parameter: string; hint: string }[] };
      };

      expect(error.code).toBe('INVALID_PARAMETERS');
      expect(error.message).toContain('vault.replace');
      expect(error.rejected.map(r => r.parameter).sort()).toEqual(['mode', 'overwrite']);
      expect(writes).toEqual([]);
    });

    it('accepts vault.replace with exactly path and content', async () => {
      const { byName, api, writes } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'replace', path: 'note.md', content: 'x',
      });

      expect(text(res)).not.toContain('INVALID_PARAMETERS');
      expect(writes).toHaveLength(1);
    });
  });

  describe('advertising', () => {
    it('lists replace and keeps update in the vault action enum', () => {
      const { byName } = setup();
      const actions = advertisedActions(byName('vault')!);

      expect(actions).toContain('replace');
      expect(actions).toContain('update');
    });

    it('presents replace in the description and marks update deprecated', () => {
      const desc = getOperationDescription('vault');

      expect(desc).toMatch(/\breplace\b/);
      expect(desc).toMatch(/update.{0,40}deprecated/i);
      // The action list no longer presents update as a peer of create/delete.
      expect(desc).not.toMatch(/create, update, delete/);
    });

    it('points hints that described update at replace', async () => {
      const { byName, api } = setup();

      const res = await byName('vault')!.handler(api, {
        action: 'replace', path: 'note.md', content: 'x', overwrite: false,
      });

      expect(text(res)).toContain('vault.replace always replaces the entire file contents');
    });
  });

  /**
   * One capability under two names gets one switch. If `replace` had its own
   * default-on toggle, a user who had switched `update` off to stop whole-file
   * overwrites would silently regain them through `replace` on upgrade.
   */
  describe('tool visibility', () => {
    it('a stored vault.update=false also hides and blocks vault.replace', async () => {
      const { byName, api, writes } = setup({ visibility: { 'vault.update': false } });
      const vault = byName('vault')!;

      expect(advertisedActions(vault)).not.toContain('replace');
      expect(advertisedActions(vault)).not.toContain('update');

      const res = await vault.handler(api, { action: 'replace', path: 'note.md', content: 'x' });
      expect(text(res)).toContain('ACTION_DISABLED');
      expect(writes).toEqual([]);
    });

    it('vault.replace=false also hides and blocks vault.update', async () => {
      const { byName, api, writes } = setup({ visibility: { 'vault.replace': false } });
      const vault = byName('vault')!;

      expect(advertisedActions(vault)).not.toContain('update');

      const res = await vault.handler(api, { action: 'update', path: 'note.md', content: 'x' });
      expect(text(res)).toContain('ACTION_DISABLED');
      expect(writes).toEqual([]);
    });

    it('a stale vault.update=false with a stored vault.replace=true still hides both', () => {
      const { byName } = setup({ visibility: { 'vault.update': false, 'vault.replace': true } });
      expect(advertisedActions(byName('vault')!)).not.toContain('replace');
    });

    it('leaves sibling actions untouched', () => {
      const { byName } = setup({ visibility: { 'vault.replace': false } });
      const actions = advertisedActions(byName('vault')!);

      expect(actions).toEqual(expect.arrayContaining(['create', 'delete', 'read']));
    });
  });

  /**
   * The settings tab's toggle logic, extracted from main.ts so it can be tested
   * without Obsidian. These are the reads and writes the vault.replace row makes.
   */
  describe('settings tree toggles', () => {
    it('shows one vault row for the two names', () => {
      const rows = visibilityTreeActions('vault');
      expect(rows).toContain('replace');
      expect(rows).not.toContain('update');
    });

    it('reads the replace row as off when only vault.update=false is stored, and hides both', () => {
      const v = { 'vault.update': false };

      expect(visibilityRowValue(v, 'vault.replace')).toBe(false);
      expect(isActionVisible(v, 'vault', 'replace')).toBe(false);
      expect(isActionVisible(v, 'vault', 'update')).toBe(false);
    });

    it('reads the replace row as on when neither key is stored', () => {
      expect(visibilityRowValue({}, 'vault.replace')).toBe(true);
      expect(visibilityRowValue({}, 'vault')).toBe(true);
    });

    it('turning the row on writes both keys true', () => {
      const v = applyVisibilityToggle({ 'vault.update': false }, 'vault.replace', true);

      expect(v['vault.replace']).toBe(true);
      expect(v['vault.update']).toBe(true);
      expect(isActionVisible(v, 'vault', 'update')).toBe(true);
    });

    it('turning the row off writes both keys false', () => {
      const v = applyVisibilityToggle({}, 'vault.replace', false);

      expect(v).toEqual({ 'vault.replace': false, 'vault.update': false });
    });

    it('fixes the stale-key case (update on, replace off) with one toggle', () => {
      const v: Record<string, boolean> = { 'vault.update': true, 'vault.replace': false };
      expect(isActionVisible(v, 'vault', 'update')).toBe(false);
      expect(visibilityRowValue(v, 'vault.replace')).toBe(false);

      applyVisibilityToggle(v, 'vault.replace', true);

      expect(isActionVisible(v, 'vault', 'replace')).toBe(true);
      expect(isActionVisible(v, 'vault', 'update')).toBe(true);
    });

    it('the parent-level cascade writes both keys', () => {
      const off = applyVisibilityToggle({}, 'vault', false);
      expect(off.vault).toBe(false);
      expect(off['vault.replace']).toBe(false);
      expect(off['vault.update']).toBe(false);

      const on = applyVisibilityToggle(off, 'vault', true);
      expect(on['vault.replace']).toBe(true);
      expect(on['vault.update']).toBe(true);
      expect(visibilityRowValue(on, 'vault')).toBe(true);
    });

    it('turning off every row marks the operation off, and one row back on clears it', () => {
      const v: Record<string, boolean> = {};
      for (const a of visibilityTreeActions('vault')) applyVisibilityToggle(v, `vault.${a}`, false);
      expect(v.vault).toBe(false);
      expect(visibilityRowValue(v, 'vault')).toBe(false);

      applyVisibilityToggle(v, 'vault.read', true);
      expect('vault' in v).toBe(false);
      expect(visibilityRowValue(v, 'vault')).toBe(true);
    });

    it('changes the map it was given, so live tool handlers see the toggle', async () => {
      const visibility: Record<string, boolean> = {};
      const { byName, api, writes } = setup({ visibility });
      const vault = byName('vault')!;

      applyVisibilityToggle(visibility, 'vault.replace', false);
      const res = await vault.handler(api, { action: 'update', path: 'note.md', content: 'x' });

      expect(text(res)).toContain('ACTION_DISABLED');
      expect(writes).toEqual([]);
    });
  });
});
