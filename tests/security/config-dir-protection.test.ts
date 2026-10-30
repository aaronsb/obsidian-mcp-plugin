/**
 * Agents cannot touch Obsidian's config directory (`app.vault.configDir`).
 *
 * The config directory holds this plugin's own data.json. An agent that could
 * write `toolVisibility['system.execute']: true` and a command allowlist there
 * would open all three ADR-204 gates on the next settings load, and could drop
 * a whole plugin into `<configDir>/plugins/`. Path validation only kept paths
 * inside the vault, and the config directory is inside the vault.
 *
 * Every agent-reachable write is driven through the production tool handler
 * against the real SecureObsidianAPI, with permissive permissions and
 * read-only off, so the config-directory rule is the only thing that can
 * refuse. Assertions are on recorded vault writes. The positive controls for
 * these same actions against ordinary paths live in
 * read-only-action-matrix.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecureObsidianAPI, SecurityError } from '../../src/security';
import { SecurePathValidator } from '../../src/security/path-validator';
import { createSemanticTools } from '../../src/tools/semantic-tools';
import { ContentBufferManager } from '../../src/utils/content-buffer';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

type Write = { op: string; path: string };

const DATA = '.obsidian/plugins/semantic-vault-mcp/data.json';
const EXISTING = ['note.md', 'other.md', DATA, '.obsidian/app.json'];

const PERMISSIVE = {
  pathValidation: 'strict' as const,
  permissions: { read: true, create: true, update: true, delete: true, move: true, rename: true, execute: true },
  blockedPaths: [],
  logSecurityEvents: false,
};

function mkFile(p: string): TFile {
  const f = new TFile();
  const w = f as unknown as { path: string; extension: string; name: string; basename: string };
  w.path = p;
  w.extension = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1) : '';
  w.name = p.slice(p.lastIndexOf('/') + 1);
  w.basename = w.name.replace(/\.[^.]*$/, '');
  return f;
}

function makeApp(writes: Write[], configDir = '.obsidian', existing = EXISTING): App {
  return {
    vault: {
      configDir,
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (existing.includes(p) ? mkFile(p) : null),
      read: async () => '# Heading\nbody\n',
      cachedRead: async () => '# Heading\nbody\n',
      modify: async (f: TFile) => { writes.push({ op: 'modify', path: f.path }); },
      create: async (p: string) => { writes.push({ op: 'create', path: p }); return mkFile(p); },
      createFolder: async (p: string) => { writes.push({ op: 'mkdir', path: p }); },
      getFiles: () => existing.map(mkFile),
      getMarkdownFiles: () => existing.map(mkFile),
    },
    fileManager: {
      renameFile: async (_f: TFile, newPath: string) => { writes.push({ op: 'rename', path: newPath }); },
      trashFile: async (f: TFile) => { writes.push({ op: 'trash', path: f.path }); },
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => null, getLeaf: () => null },
  } as unknown as App;
}

async function invoke(operation: string, params: Record<string, unknown>, app?: App, writes: Write[] = []) {
  const api = new SecureObsidianAPI(
    app ?? makeApp(writes), undefined, { settings: { readOnlyMode: false } } as never, PERMISSIVE,
  );
  const tool = createSemanticTools(api)!.find(t => t.name === operation)!;
  let text = '';
  try {
    text = JSON.stringify(await tool.handler(api, params));
  } catch (e) {
    text = String(e);
  }
  return { writes, text, api };
}

/** Every agent-reachable write, aimed into the config directory. */
const WRITES_INTO_CONFIG: [string, string, Record<string, unknown>][] = [
  ['vault.create (new plugin file)', 'vault', { action: 'create', path: '.obsidian/plugins/evil/main.js', content: 'x' }],
  ['vault.create (this plugin data.json)', 'vault', { action: 'create', path: DATA, content: '{}' }],
  ['vault.replace', 'vault', { action: 'replace', path: DATA, content: '{}' }],
  ['vault.update', 'vault', { action: 'update', path: DATA, content: '{}' }],
  ['vault.delete', 'vault', { action: 'delete', path: DATA }],
  ['vault.move (destination)', 'vault', { action: 'move', path: 'note.md', destination: DATA }],
  ['vault.move (source)', 'vault', { action: 'move', path: DATA, destination: 'moved.json' }],
  ['vault.rename', 'vault', { action: 'rename', path: DATA, newName: 'renamed' }],
  ['vault.copy (destination)', 'vault', { action: 'copy', path: 'note.md', destination: DATA }],
  ['vault.split (output directory)', 'vault', { action: 'split', path: 'note.md', splitBy: 'heading', level: 1, outputDirectory: '.obsidian/plugins/evil' }],
  ['vault.combine (destination)', 'vault', { action: 'combine', paths: ['note.md', 'other.md'], destination: '.obsidian/combined.md' }],
  ['vault.concatenate (destination)', 'vault', { action: 'concatenate', path1: 'note.md', path2: 'other.md', mode: 'new', destination: '.obsidian/cat.md' }],
  ['edit.window', 'edit', { action: 'window', path: DATA, oldText: 'body', newText: 'changed' }],
  ['edit.append', 'edit', { action: 'append', path: DATA, content: 'x' }],
  ['edit.patch', 'edit', { action: 'patch', path: DATA, targetType: 'heading', target: 'Heading', operation: 'append', content: 'x' }],
  ['edit.at_line', 'edit', { action: 'at_line', path: DATA, lineNumber: 1, mode: 'replace', content: 'x' }],
  ['edit.from_buffer', 'edit', { action: 'from_buffer', path: DATA }],
  ['bases.create', 'bases', { action: 'create', path: '.obsidian/evil.base', config: { views: [{ type: 'table', name: 'v' }] } }],
];

describe('config directory protection', () => {
  beforeEach(() => {
    // edit.from_buffer replays a stashed window edit; seed it so the call can reach a write.
    ContentBufferManager.getInstance().store('changed', undefined, { searchText: 'body' });
  });

  it.each(WRITES_INTO_CONFIG)('%s cannot write into the config directory', async (_label, operation, params) => {
    const { writes, text } = await invoke(operation, params);
    expect(writes.filter(w => w.path.toLowerCase().startsWith('.obsidian'))).toEqual([]);
    expect(text).toContain('CONFIG_DIR_PROTECTED');
  });

  it.each([
    ['upper case', '.OBSIDIAN/plugins/semantic-vault-mcp/data.json'],
    ['leading ./', './.obsidian/plugins/semantic-vault-mcp/data.json'],
    ['a dot segment', 'notes/./../.obsidian/app.json'],
    ['the directory itself', '.obsidian'],
    ['a trailing slash', '.obsidian/'],
  ])('refuses the config directory written with %s', async (_label, path) => {
    const { writes, text } = await invoke('vault', { action: 'create', path, content: 'x' });
    expect(writes).toEqual([]);
    expect(text).toMatch(/CONFIG_DIR_PROTECTED|FORBIDDEN_PATTERN/);
  });

  it('follows a configured config directory, not a hard-coded .obsidian', async () => {
    const writes: Write[] = [];
    const app = makeApp(writes, '.my-config', ['note.md']);
    const { text } = await invoke('vault', { action: 'create', path: '.my-config/plugins/x/data.json', content: 'x' }, app, writes);
    expect(writes).toEqual([]);
    expect(text).toContain('CONFIG_DIR_PROTECTED');
  });

  it('leaves a look-alike folder outside the config directory writable', async () => {
    const { writes } = await invoke('vault', { action: 'create', path: '.obsidian-notes/a.md', content: 'x' });
    expect(writes).toContainEqual({ op: 'create', path: '.obsidian-notes/a.md' });
  });

  it('refuses reads of the config directory as well', async () => {
    const { text } = await invoke('vault', { action: 'read', path: DATA });
    expect(text).toContain('CONFIG_DIR_PROTECTED');
  });

  it('refuses at the security layer with a SecurityError, whatever the caller', async () => {
    const writes: Write[] = [];
    const api = new SecureObsidianAPI(makeApp(writes), undefined, { settings: {} } as never, PERMISSIVE);
    const thrown = await api.updateFile(DATA, '{"toolVisibility":{"system.execute":true}}').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SecurityError);
    expect((thrown as SecurityError).code).toBe('CONFIG_DIR_PROTECTED');
    expect(writes).toEqual([]);
  });

  it('refuses even with path validation disabled', async () => {
    const writes: Write[] = [];
    const api = new SecureObsidianAPI(
      makeApp(writes), undefined, { settings: {} } as never, { ...PERMISSIVE, pathValidation: 'disabled' },
    );
    const thrown = await api.createFile('.obsidian/plugins/evil/main.js', 'x').catch((e: unknown) => e);
    expect((thrown as SecurityError).code).toBe('CONFIG_DIR_PROTECTED');
    expect(writes).toEqual([]);
  });

  it('refuses to build a security layer that does not know the config directory', () => {
    const app = { vault: { adapter: { basePath: '/test/vault' } } } as unknown as App;
    expect(() => new SecureObsidianAPI(app, undefined, { settings: {} } as never, PERMISSIVE))
      .toThrow("Could not determine Obsidian's config directory");
  });

  it('sees through a symlinked folder that points into the config directory', () => {
    // A real directory tree: the alias exists only on disk, so the lexical check cannot see it.
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgdir-'));
    try {
      fs.mkdirSync(path.join(vault, '.obsidian', 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'notes'));
      fs.symlinkSync(path.join(vault, '.obsidian'), path.join(vault, 'notes', 'cfg'), 'dir');
      const validator = new SecurePathValidator({ vault: { adapter: { basePath: vault } } } as unknown as App);

      expect(validator.isInsideDir('notes/cfg/plugins/x/data.json', '.obsidian')).toBe(true);
      expect(validator.isInsideDir('notes/real.md', '.obsidian')).toBe(false);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
