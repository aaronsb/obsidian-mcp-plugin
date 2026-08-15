/**
 * Per-action parameter validation on destructive vault actions.
 *
 * The input schema is built per operation, so every `vault` action accepts the
 * union of all `vault` parameters. Handlers read what they need and ignore the
 * rest. On a read that is harmless. On a write it means the caller's wrong
 * assumption gets acted on silently — the two cases that motivated this:
 *
 *   vault.update + mode: 'append'   -> file replaced; the caller wanted
 *                                      edit.append and did not know it existed
 *   vault.update + overwrite: false -> file replaced despite an explicit
 *                                      instruction not to
 *
 * Both returned success and left no diff.
 *
 * Assertions are on RECORDED VAULT WRITES, following tool-visibility.test.ts:
 * "rejected" has to mean no write happened, not merely that an error string was
 * returned somewhere.
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

function setup() {
  const writes: Write[] = [];
  const plugin = { settings: { readOnlyMode: false } };
  const api = new SecureObsidianAPI(
    makeApp(writes), undefined, plugin as never, BASELINE_SECURITY_SETTINGS,
  );
  const tools = createSemanticTools(api, undefined) ?? [];
  return { writes, api, byName: (n: string) => tools.find(t => t.name === n) };
}

describe('per-action parameter validation', () => {
  describe('destructive actions reject inapplicable parameters', () => {
    it('refuses vault.update carrying `mode`, and records no write', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append',
      });

      expect(JSON.stringify(res)).toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([]);
    });

    it('refuses vault.update carrying `overwrite`, and records no write', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', overwrite: false,
      });

      expect(JSON.stringify(res)).toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([]);
    });

    it('refuses vault.delete carrying an inapplicable parameter', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'delete', path: 'note.md', destination: 'other.md',
      });

      expect(JSON.stringify(res)).toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([]);
    });

    it('refuses regardless of the inapplicable parameter\'s value', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      // The gate keys on the parameter NAME, so mode='prepend' is caught the
      // same as mode='append'. Both are values of a parameter that does not
      // belong to vault.update at all.
      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'prepend',
      });

      expect(JSON.stringify(res)).toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([]);
    });

    it('names every inapplicable parameter it rejected', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append', newName: 'z.md',
      });
      const text = JSON.stringify(res);

      expect(text).toContain('mode');
      expect(text).toContain('newName');
    });
  });

  /**
   * One error carrying a per-parameter breakdown, rather than one blob of
   * concatenated advice — a caller that sent three wrong parameters should get
   * three hints, each attached to the parameter it is about.
   */
  describe('error shape', () => {
    function parse(res: unknown) {
      const r = res as { content: { text: string }[] };
      return JSON.parse(r.content[0].text) as {
        error: { code: string; message: string; rejected: { parameter: string; hint: string }[] };
      };
    }

    it('reports one entry per rejected parameter, each with its own hint', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append', overwrite: false,
      });
      const { error } = parse(res);

      expect(error.rejected.map(r => r.parameter).sort()).toEqual(['mode', 'overwrite']);
      expect(error.rejected.find(r => r.parameter === 'mode')!.hint).toContain('edit.append');
      expect(error.rejected.find(r => r.parameter === 'overwrite')!.hint).toContain('vault.move');
    });

    it('uses singular phrasing for one parameter', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append',
      });

      expect(parse(res).error.message).toContain("Parameter 'mode' does not apply");
    });

    it('uses plural phrasing for several parameters', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append', newName: 'z.md',
      });

      expect(parse(res).error.message).toContain('Parameters ');
      expect(parse(res).error.message).toContain('do not apply');
    });

    it('falls back to a generic hint for a parameter with no specific owner', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', notARealParameter: 1,
      });
      const { error } = parse(res);

      expect(error.rejected).toHaveLength(1);
      expect(error.rejected[0].hint).toContain('is not a parameter of vault.update');
    });

    it('has a specific hint for every vault parameter a caller could misplace', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      // Sampled across each family: move/copy, split, search, combine, read.
      const families = ['destination', 'splitBy', 'query', 'paths', 'returnFullFile'];

      for (const name of families) {
        const res = await vault.handler(api, {
          action: 'update', path: 'note.md', content: 'x', [name]: 'v',
        });
        const { error } = parse(res);
        expect(error.rejected[0].hint).not.toContain('is not a parameter of');
      }
    });
  });

  /**
   * The rejection is only half the value. A caller passing `mode: 'append'` to
   * vault.update is trying to append, and the API has an append — so the error
   * should hand them the action they were reaching for.
   */
  describe('hints point at the action the parameter belongs to', () => {
    it('points a misplaced `mode` at edit.append', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', mode: 'append',
      });

      expect(JSON.stringify(res)).toContain('edit.append');
    });

    it('explains that `overwrite` belongs to move/copy and that update always replaces', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'x', overwrite: false,
      });
      const text = JSON.stringify(res);

      expect(text).toContain('vault.move');
      expect(text).toContain('always replaces');
    });
  });

  /**
   * Guarding writes is easy; not breaking working callers is the part that
   * decides whether this is shippable.
   */
  describe('no false positives', () => {
    it('allows vault.update with exactly its own parameters, and records the write', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'replacement',
      });

      expect(JSON.stringify(res)).not.toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([{ op: 'modify', path: 'note.md' }]);
    });

    it('allows the universal `raw` parameter alongside a destructive action', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'update', path: 'note.md', content: 'replacement', raw: true,
      });

      expect(JSON.stringify(res)).not.toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([{ op: 'modify', path: 'note.md' }]);
    });

    it('allows vault.create with its own parameters', async () => {
      const { byName, api, writes } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'create', path: 'fresh.md', content: 'hello',
      });

      expect(JSON.stringify(res)).not.toContain('INVALID_PARAMETERS');
      expect(writes).toEqual([{ op: 'create', path: 'fresh.md' }]);
    });

    it('leaves read paths permissive — a stray parameter on a read is not an error', async () => {
      const { byName, api } = setup();
      const vault = byName('vault')!;

      const res = await vault.handler(api, {
        action: 'read', path: 'note.md', mode: 'append',
      });

      expect(JSON.stringify(res)).not.toContain('INVALID_PARAMETERS');
    });

    it('leaves edit actions ungated', async () => {
      const { byName, api, writes } = setup();
      const edit = byName('edit')!;

      const res = await edit.handler(api, {
        action: 'append', path: 'note.md', content: 'appended',
      });

      expect(JSON.stringify(res)).not.toContain('INVALID_PARAMETERS');
      expect(writes.length).toBeGreaterThan(0);
    });
  });
});
