/**
 * `readonly:` rules in .mcpignore (#275).
 *
 * Two layers under test, each through its real implementation:
 *  - MCPIgnoreManager parses `readonly:` / `!readonly:` lines into a rule set
 *    separate from exclusions, with last-match-wins negation.
 *  - VaultSecurityManager refuses every write to a read-only path and every
 *    move/copy into one, while reads and copies *out of* one proceed.
 *
 * Only the vault adapter (the .mcpignore bytes) is stubbed.
 */
import { App } from 'obsidian';
import { MCPIgnoreManager } from '../../src/security/mcp-ignore-manager';
import { OperationType, VaultSecurityManager } from '../../src/security/vault-security-manager';

async function managerWith(content: string): Promise<MCPIgnoreManager> {
  const app = {
    vault: {
      adapter: {
        stat: async () => ({ mtime: 1, ctime: 1, size: content.length, type: 'file' as const }),
        read: async () => content
      }
    }
  } as unknown as App;

  const manager = new MCPIgnoreManager(app);
  manager.setEnabled(true);
  await manager.loadIgnoreFile();
  return manager;
}

describe('.mcpignore readonly: rules (#275)', () => {
  describe('MCPIgnoreManager parsing', () => {
    it('marks a readonly: subtree read-only without excluding it', async () => {
      const manager = await managerWith('readonly:sources/**');

      expect(manager.isReadOnly('sources/paper.md')).toBe(true);
      expect(manager.isReadOnly('sources/deep/nested.md')).toBe(true);
      expect(manager.isExcluded('sources/paper.md')).toBe(false);
    });

    it('marks a single file read-only, anywhere in the vault when unanchored', async () => {
      const manager = await managerWith('readonly:architecture.md');

      expect(manager.isReadOnly('architecture.md')).toBe(true);
      expect(manager.isReadOnly('docs/architecture.md')).toBe(true);
      expect(manager.isReadOnly('docs/other.md')).toBe(false);
    });

    it('!readonly: re-opens a path for writing, last match wins', async () => {
      const manager = await managerWith(['readonly:sources/**', '!readonly:sources/notes/**'].join('\n'));

      expect(manager.isReadOnly('sources/raw.md')).toBe(true);
      expect(manager.isReadOnly('sources/notes/mine.md')).toBe(false);
    });

    it('keeps exclusion rules and readonly rules in separate sets', async () => {
      const manager = await managerWith(['private/', 'readonly:sources/**'].join('\n'));

      expect(manager.isExcluded('private/secret.md')).toBe(true);
      expect(manager.isReadOnly('private/secret.md')).toBe(false);
      expect(manager.isExcluded('sources/raw.md')).toBe(false);
      expect(manager.isReadOnly('sources/raw.md')).toBe(true);
      expect(manager.getStats()).toMatchObject({ patternCount: 2, readonlyPatternCount: 1 });
    });

    it('a readonly: line with an empty pattern is ignored', async () => {
      const manager = await managerWith('readonly:');

      expect(manager.getStats().readonlyPatternCount).toBe(0);
      expect(manager.isReadOnly('anything.md')).toBe(false);
    });

    it('reports nothing read-only when exclusions are disabled', async () => {
      const manager = await managerWith('readonly:sources/**');
      manager.setEnabled(false);

      expect(manager.isReadOnly('sources/raw.md')).toBe(false);
    });
  });

  describe('VaultSecurityManager enforcement', () => {
    let security: VaultSecurityManager;

    beforeEach(async () => {
      const ignore = await managerWith(['private/', 'readonly:sources/**', '!readonly:sources/notes/**'].join('\n'));
      // Path validation is exercised for real; the validator only needs a base
      // directory from the App.
      const app = { vault: { adapter: { basePath: '/test/vault' } } } as unknown as App;
      security = new VaultSecurityManager(app, {}, ignore);
    });

    const op = (type: OperationType, path: string, targetPath?: string) =>
      security.validateOperation({ type, path, targetPath });

    it('allows reads of a read-only path', async () => {
      await expect(op(OperationType.READ, 'sources/raw.md')).resolves.toMatchObject({ type: OperationType.READ });
    });

    it.each([
      OperationType.CREATE,
      OperationType.UPDATE,
      OperationType.DELETE,
      OperationType.RENAME,
    ])('refuses %s on a read-only path with PATH_READ_ONLY', async (type) => {
      await expect(op(type, 'sources/raw.md', type === OperationType.RENAME ? 'sources/renamed.md' : undefined))
        .rejects.toMatchObject({ code: 'PATH_READ_ONLY' });
    });

    it('refuses moving a file out of a read-only path (the source is removed)', async () => {
      await expect(op(OperationType.MOVE, 'sources/raw.md', 'inbox/raw.md'))
        .rejects.toMatchObject({ code: 'PATH_READ_ONLY' });
    });

    it('allows copying out of a read-only path, which only reads the source', async () => {
      await expect(op(OperationType.COPY, 'sources/raw.md', 'inbox/raw.md'))
        .resolves.toMatchObject({ type: OperationType.COPY });
    });

    it('refuses moving or copying into a read-only path with TARGET_PATH_READ_ONLY', async () => {
      await expect(op(OperationType.MOVE, 'inbox/new.md', 'sources/new.md'))
        .rejects.toMatchObject({ code: 'TARGET_PATH_READ_ONLY' });
      await expect(op(OperationType.COPY, 'inbox/new.md', 'sources/new.md'))
        .rejects.toMatchObject({ code: 'TARGET_PATH_READ_ONLY' });
    });

    it('allows writes where !readonly: re-opened the path', async () => {
      await expect(op(OperationType.UPDATE, 'sources/notes/mine.md'))
        .resolves.toMatchObject({ type: OperationType.UPDATE });
    });

    it('exclusion wins over read-only: an excluded path is blocked, not read-only', async () => {
      await expect(op(OperationType.READ, 'private/secret.md'))
        .rejects.toMatchObject({ code: 'PATH_BLOCKED' });
    });

    it('leaves paths outside any readonly: rule writable', async () => {
      await expect(op(OperationType.DELETE, 'inbox/old.md'))
        .resolves.toMatchObject({ type: OperationType.DELETE });
    });
  });
});
