/**
 * Every vault write must pass through the security layer.
 *
 * Three bypasses shipped in 0.11.42, all the same shape — a write that reached
 * the vault without going through SecureObsidianAPI, so neither the read-only
 * permission check nor path validation applied:
 *
 *   1. bases.create   -> app.vault.create() direct (bases-api.ts)
 *   2. vault.move     -> app.fileManager.renameFile() direct (vault.ts)
 *   3. vault.rename   -> app.fileManager.renameFile() direct (vault.ts)
 *
 * (2) and (3) escaped the vault root in DEFAULT configuration — no read-only
 * needed — and being moves, they removed data from the vault.
 *
 * These tests assert on RECORDED WRITES, not error strings: a friendly error
 * message means nothing if the write already landed.
 */
import { SecureObsidianAPI, VaultSecurityManager, SecurityError } from '../../src/security';
import { SemanticRouter } from '../../src/semantic/router';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

type Write = { op: string; path: string };

const PERMISSIVE = {
  pathValidation: 'strict' as const,
  permissions: {
    read: true, create: true, update: true,
    delete: true, move: true, rename: true, execute: true,
  },
  blockedPaths: [],
  logSecurityEvents: false,
};

function mkFile(p: string): TFile {
  const f = new TFile();
  (f as unknown as { path: string; extension: string; name: string }).path = p;
  (f as unknown as { path: string; extension: string; name: string }).extension =
    p.includes('.') ? p.slice(p.lastIndexOf('.') + 1) : '';
  (f as unknown as { path: string; extension: string; name: string }).name = p;
  return f;
}

function makeApp(existing: string[], writes: Write[]): App {
  const has = (p: string) => existing.includes(p);
  return {
    vault: {
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (has(p) ? mkFile(p) : null),
      read: async () => 'body\n',
      cachedRead: async () => 'body\n',
      modify: async (f: TFile, _c: string) => { writes.push({ op: 'modify', path: f.path }); },
      create: async (p: string, _c: string) => { writes.push({ op: 'create', path: p }); return mkFile(p); },
      getFiles: () => existing.map(mkFile),
    },
    fileManager: {
      renameFile: async (f: TFile, newPath: string) => {
        writes.push({ op: 'rename', path: newPath });
      },
      trashFile: async (f: TFile) => { writes.push({ op: 'trash', path: f.path }); },
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => mkFile('active.md') },
  } as unknown as App;
}

describe('write-path containment', () => {
  let writes: Write[];

  beforeEach(() => { writes = []; });

  describe('bases.create goes through the security layer', () => {
    it('is blocked by read-only mode', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never,
        VaultSecurityManager.presets.readOnly()
      );

      await expect(
        api.createBase('x.base', { views: [{ type: 'table', name: 'v' }] } as never)
      ).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it('rejects a traversal path even with writes permitted', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never, PERMISSIVE
      );

      await expect(
        api.createBase('../escaped.base', { views: [{ type: 'table', name: 'v' }] } as never)
      ).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it('still creates a base at a legitimate path', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never, PERMISSIVE
      );

      await api.createBase('views/ok.base', { views: [{ type: 'table', name: 'v' }] } as never);
      expect(writes).toEqual([{ op: 'create', path: 'views/ok.base' }]);
    });
  });

  describe('renameFile validates source and destination', () => {
    it('rejects a traversal destination even with writes permitted', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never, PERMISSIVE
      );

      await expect(api.renameFile('note.md', '../escaped.md')).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it('is blocked by read-only mode', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never,
        VaultSecurityManager.presets.readOnly()
      );

      await expect(api.renameFile('note.md', 'renamed.md')).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });

    it('still renames within the vault', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['note.md'], writes), undefined, { settings: {} } as never, PERMISSIVE
      );

      await api.renameFile('note.md', 'renamed.md');
      expect(writes).toEqual([{ op: 'rename', path: 'renamed.md' }]);
    });
  });

  describe('active-file writes go through the security layer', () => {
    it('blocks update/append/delete under read-only', async () => {
      const api = new SecureObsidianAPI(
        makeApp(['active.md'], writes), undefined, { settings: {} } as never,
        VaultSecurityManager.presets.readOnly()
      );

      await expect(api.updateActiveFile('x')).rejects.toThrow(SecurityError);
      await expect(api.appendToActiveFile('x')).rejects.toThrow(SecurityError);
      await expect(api.deleteActiveFile()).rejects.toThrow(SecurityError);
      expect(writes).toEqual([]);
    });
  });

  /**
   * End-to-end through the real router — this is the shape that actually escaped
   * the vault live in 0.11.42, in default configuration.
   */
  describe('router-level: the confirmed live exploits', () => {
    function router(existing: string[]) {
      const app = makeApp(existing, writes);
      const api = new SecureObsidianAPI(app, undefined, { settings: {} } as never, PERMISSIVE);
      return new SemanticRouter(api, app);
    }

    it('vault.move cannot relocate a file outside the vault', async () => {
      const r = router(['sec/victim.md']);

      const res = await r.route({
        operation: 'vault',
        action: 'move',
        params: { path: 'sec/victim.md', destination: '../escaped.md' },
      });

      expect(writes).toEqual([]);
      expect(JSON.stringify(res)).not.toContain('Successfully moved');
    });

    it('vault.rename cannot relocate a file outside the vault', async () => {
      const r = router(['sec/victim.md']);

      const res = await r.route({
        operation: 'vault',
        action: 'rename',
        params: { path: 'sec/victim.md', newName: '../../escaped.md' },
      });

      expect(writes).toEqual([]);
      expect(JSON.stringify(res)).not.toContain('Successfully renamed');
    });

    it('vault.move still works for a legitimate destination', async () => {
      const r = router(['sec/victim.md']);

      await r.route({
        operation: 'vault',
        action: 'move',
        params: { path: 'sec/victim.md', destination: 'archive/victim.md' },
      });

      expect(writes).toEqual([{ op: 'rename', path: 'archive/victim.md' }]);
    });
  });
});
