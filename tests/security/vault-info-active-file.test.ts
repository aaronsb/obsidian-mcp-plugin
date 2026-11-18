/**
 * The obsidian://vault-info resource checks the active file's path.
 *
 * The resource read the open note straight from the workspace, outside
 * SecureObsidianAPI, and returned its name and path. With an .mcpignore-excluded
 * note or a config-directory file open in Obsidian, any MCP client could read
 * that resource and learn the path. The file is now checked as a vault.read of
 * its path would be, and left out when the check refuses it. File counts leave
 * out .mcpignore-excluded paths, as listFiles does.
 *
 * Real SecureObsidianAPI, MCPIgnoreManager and MCPServerPool, read through an
 * in-memory MCP transport. Only the Obsidian app is faked.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { App, TFile } from 'obsidian';
import { SecureObsidianAPI } from '../../src/security';
import { MCPIgnoreManager } from '../../src/security/mcp-ignore-manager';
import { MCPServerPool } from '../../src/utils/mcp-server-pool';

jest.mock('obsidian');
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

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

const VAULT_FILES = [
  'notes/today.md',
  'notes/ideas.md',
  'private/diary.md',
  'private/plans.md',
  'private/scan.png',
  'img/photo.png',
];

async function setup(active: string | null, rules = 'private/') {
  const files = VAULT_FILES.map(mkFile);
  const app = {
    vault: {
      configDir: '.obsidian',
      getName: () => 'Test Vault',
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => files.find(f => f.path === p) ?? null,
      getAllLoadedFiles: () => files,
      getMarkdownFiles: () => files.filter(f => f.extension === 'md'),
      getFiles: () => files,
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => (active === null ? null : mkFile(active)) },
  } as unknown as App;
  const plugin = {
    settings: { readOnlyMode: false },
    ignoreManager: await ignoreRules(rules),
  };
  const api = new SecureObsidianAPI(app, undefined, plugin as never, PERMISSIVE);
  return { api, plugin };
}

type VaultInfo = {
  vault: { name: string };
  activeFile: { name: string; path: string; basename: string; extension: string } | null;
  files: { total: number; markdown: number; attachments: number };
};

async function readVaultInfo(api: SecureObsidianAPI, plugin: unknown): Promise<{ info: VaultInfo; raw: string }> {
  const pool = new MCPServerPool(api, 4, plugin as never);
  try {
    const server = pool.getOrCreateServer('session-vault-info');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    const res = await client.readResource({ uri: 'obsidian://vault-info' });
    const raw = (res.contents[0] as { text: string }).text;
    return { info: JSON.parse(raw) as VaultInfo, raw };
  } finally {
    pool.shutdown();
  }
}

describe('obsidian://vault-info active file', () => {
  it('reports an ordinary active note (positive control)', async () => {
    const { api, plugin } = await setup('notes/today.md');
    const { info } = await readVaultInfo(api, plugin);

    expect(info.vault.name).toBe('Test Vault');
    expect(info.activeFile).toEqual({
      name: 'today.md',
      path: 'notes/today.md',
      basename: 'today',
      extension: 'md',
    });
  });

  it('leaves out an .mcpignore-excluded active note', async () => {
    const { api, plugin } = await setup('private/diary.md');
    const { info, raw } = await readVaultInfo(api, plugin);

    expect(info.activeFile).toBeNull();
    expect(raw).not.toContain('diary');
    expect(raw).not.toContain('private');
  });

  it('leaves out a config-directory file that is open in the editor', async () => {
    const { api, plugin } = await setup('.obsidian/plugins/obsidian-mcp-plugin/data.json');
    const { info, raw } = await readVaultInfo(api, plugin);

    expect(info.activeFile).toBeNull();
    expect(raw).not.toContain('data.json');
    expect(raw).not.toContain('.obsidian');
  });

  it('leaves out a note blocked by the blockedPaths setting', async () => {
    const { api, plugin } = await setup('notes/ideas.md');
    api.updateSecuritySettings({ blockedPaths: ['notes/ideas.md'] });
    const { info } = await readVaultInfo(api, plugin);

    expect(info.activeFile).toBeNull();
  });

  it('reports null when no note is open', async () => {
    const { api, plugin } = await setup(null);
    const { info } = await readVaultInfo(api, plugin);

    expect(info.activeFile).toBeNull();
  });

  it('still reports a readonly: note, because reading it is allowed', async () => {
    const { api, plugin } = await setup('notes/today.md', 'readonly:notes/**');
    const { info } = await readVaultInfo(api, plugin);

    expect(info.activeFile?.path).toBe('notes/today.md');
  });

  it('still returns the rest of the resource when the active file is left out', async () => {
    const { api, plugin } = await setup('private/diary.md');
    const { info } = await readVaultInfo(api, plugin);

    expect(info.vault.name).toBe('Test Vault');
    expect(info.files.total).toBeGreaterThan(0);
  });
});

describe('obsidian://vault-info file counts', () => {
  it('leaves out .mcpignore-excluded files', async () => {
    const { api, plugin } = await setup('notes/today.md');
    const { info } = await readVaultInfo(api, plugin);

    // 6 files in the vault; the three under private/ are not counted.
    expect(info.files).toEqual({ total: 3, markdown: 2, attachments: 1 });
  });

  it('counts every file when nothing is excluded', async () => {
    const { api, plugin } = await setup('notes/today.md', '');
    const { info } = await readVaultInfo(api, plugin);

    expect(info.files).toEqual({ total: 6, markdown: 4, attachments: 2 });
  });
});

describe('SecureObsidianAPI.getVaultInfoFiles', () => {
  it('rethrows an error that is not a security refusal', async () => {
    const { api } = await setup('notes/today.md');
    const boom = new Error('workspace broke');
    jest.spyOn(api.getApp().workspace, 'getActiveFile').mockImplementation(() => { throw boom; });

    await expect(api.getVaultInfoFiles()).rejects.toBe(boom);
  });

  it('leaves the active file out when reading is not permitted', async () => {
    const { api } = await setup('notes/today.md');
    api.updateSecuritySettings({ permissions: { ...PERMISSIVE.permissions, read: false } });

    const { activeFile } = await api.getVaultInfoFiles();
    expect(activeFile).toBeNull();
  });
});
