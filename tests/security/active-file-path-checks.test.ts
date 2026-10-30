/**
 * Operations on "the active file" are checked against that file's path.
 *
 * view.active and the active-file writes take no path argument, so they used
 * to validate the operation type only. The file they act on is whatever note
 * is open in Obsidian, and an agent can choose that itself with
 * view.open_in_obsidian. Without a path check, an .mcpignore-excluded note, a
 * `readonly:` note or a config-directory file open in the editor could be read
 * or changed. Each operation now validates the active file's path with its own
 * operation type, the same check a vault.read or vault.replace of that path gets.
 *
 * Real SecureObsidianAPI and MCPIgnoreManager; only the Obsidian app is faked.
 * Assertions are on what was returned or recorded as written.
 */
import { SecureObsidianAPI, SecurityError } from '../../src/security';
import { MCPIgnoreManager } from '../../src/security/mcp-ignore-manager';
import { createSemanticTools } from '../../src/tools/semantic-tools';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

type Write = { op: string; path: string };

const SECRET = 'THE-SECRET-BODY';

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
  w.extension = p.slice(p.lastIndexOf('.') + 1);
  w.name = p.slice(p.lastIndexOf('/') + 1);
  w.basename = w.name.replace(/\.[^.]*$/, '');
  return f;
}

async function ignoreRules(content: string): Promise<MCPIgnoreManager> {
  const app = {
    vault: {
      adapter: {
        stat: async () => ({ mtime: 1, ctime: 1, size: content.length, type: 'file' as const }),
        read: async () => content,
      },
    },
  } as unknown as App;
  const manager = new MCPIgnoreManager(app);
  manager.setEnabled(true);
  await manager.loadIgnoreFile();
  return manager;
}

/**
 * `active` is the open note's path, or a list read one per getActiveFile call,
 * to simulate the user switching notes while a call is in flight.
 */
async function setup(active: string | string[]) {
  const writes: Write[] = [];
  const sequence = Array.isArray(active) ? [...active] : null;
  const current = () => mkFile(sequence ? (sequence.length > 1 ? sequence.shift()! : sequence[0]) : (active as string));
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => mkFile(p),
      read: async () => `# Heading\n${SECRET}\n`,
      cachedRead: async () => `# Heading\n${SECRET}\n`,
      modify: async (f: TFile) => { writes.push({ op: 'modify', path: f.path }); },
      getFiles: () => [],
      getMarkdownFiles: () => [],
    },
    fileManager: {
      trashFile: async (f: TFile) => { writes.push({ op: 'trash', path: f.path }); },
      renameFile: async () => undefined,
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: current, getLeaf: () => null },
  } as unknown as App;
  const plugin = {
    settings: { readOnlyMode: false },
    ignoreManager: await ignoreRules(['private/', 'readonly:sources/**'].join('\n')),
  };
  const api = new SecureObsidianAPI(app, undefined, plugin as never, PERMISSIVE);
  return { api, writes };
}

const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  return e instanceof SecurityError ? e.code : e === null ? 'resolved' : `not a SecurityError: ${String(e)}`;
};

describe('active-file path checks', () => {
  describe('view.active (reachable from tools)', () => {
    async function viewActive(active: string) {
      const { api } = await setup(active);
      const view = createSemanticTools(api).find(t => t.name === 'view')!;
      return JSON.stringify(await view.handler(api, { action: 'active', raw: true }));
    }

    it('refuses an excluded active note and returns none of it', async () => {
      const text = await viewActive('private/diary.md');
      expect(text).toContain('PATH_BLOCKED');
      expect(text).not.toContain(SECRET);
    });

    it('refuses a config-directory file that is open in the editor', async () => {
      const text = await viewActive('.obsidian/snippets/theme.css');
      expect(text).toContain('CONFIG_DIR_PROTECTED');
      expect(text).not.toContain(SECRET);
    });

    it('returns an ordinary active note (positive control)', async () => {
      const text = await viewActive('notes/today.md');
      expect(text).toContain(SECRET);
      expect(text).not.toMatch(/PATH_BLOCKED|CONFIG_DIR_PROTECTED/);
    });

    it('returns a readonly: active note, because reading it is allowed', async () => {
      expect(await viewActive('sources/paper.md')).toContain(SECRET);
    });

    it('refuses when the active note changes to an excluded one mid-call', async () => {
      const { api } = await setup(['notes/today.md', 'private/diary.md']);
      expect(await codeOf(api.getActiveFile())).toBe('ACTIVE_FILE_CHANGED');
    });
  });

  describe.each([
    ['updateActiveFile', 'modify', (api: SecureObsidianAPI) => api.updateActiveFile('x')],
    ['appendToActiveFile', 'modify', (api: SecureObsidianAPI) => api.appendToActiveFile('x')],
    ['deleteActiveFile', 'trash', (api: SecureObsidianAPI) => api.deleteActiveFile()],
    ['patchActiveFile', 'modify', (api: SecureObsidianAPI) =>
      api.patchActiveFile({ targetType: 'heading', target: 'Heading', operation: 'append', content: 'y' })],
  ])('%s', (_name, op, run) => {
    it('refuses a readonly: active note with PATH_READ_ONLY and writes nothing', async () => {
      const { api, writes } = await setup('sources/paper.md');
      expect(await codeOf(run(api))).toBe('PATH_READ_ONLY');
      expect(writes).toEqual([]);
    });

    it('refuses an excluded active note with PATH_BLOCKED and writes nothing', async () => {
      const { api, writes } = await setup('private/diary.md');
      expect(await codeOf(run(api))).toBe('PATH_BLOCKED');
      expect(writes).toEqual([]);
    });

    it('refuses a config-directory file with CONFIG_DIR_PROTECTED and writes nothing', async () => {
      const { api, writes } = await setup('.obsidian/plugins/semantic-vault-mcp/data.json');
      expect(await codeOf(run(api))).toBe('CONFIG_DIR_PROTECTED');
      expect(writes).toEqual([]);
    });

    it('writes an ordinary active note (positive control)', async () => {
      const { api, writes } = await setup('notes/today.md');
      await run(api).catch(() => undefined);
      expect(writes).toContainEqual({ op, path: 'notes/today.md' });
    });
  });
});
