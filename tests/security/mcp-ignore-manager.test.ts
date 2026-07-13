/**
 * MCPIgnoreManager pattern parsing + matching.
 *
 * These tests drive the real parser and the real Minimatch pipeline. The only thing
 * stubbed is the vault adapter — an I/O boundary that supplies the .mcpignore bytes.
 * Stubbing isExcluded() itself (as tests/graph-ignore-exclusion.test.ts does, for its
 * own narrower purpose) is what let #250 ship: the matcher was inverted and no test
 * could see it.
 */
import { App } from 'obsidian';
import { MCPIgnoreManager } from '../../src/security/mcp-ignore-manager';

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

describe('MCPIgnoreManager', () => {
  describe('negation (#250)', () => {
    it('should un-exclude a whitelisted subtree when negation follows a broad exclude', async () => {
      // The exact .mcpignore from the bug report.
      const manager = await managerWith(['*', '!folder/*'].join('\n'));

      expect(manager.isExcluded('folder/note.md')).toBe(false);
    });

    it('should still exclude paths the negation does not cover', async () => {
      const manager = await managerWith(['*', '!folder/*'].join('\n'));

      expect(manager.isExcluded('top-level.md')).toBe(true);
    });

    it('should not treat a negated pattern as a positive exclusion', async () => {
      // Regression guard for the root cause: the leading '!' was stripped before
      // Minimatch saw it, leaving negate=false, which turned '!folder/*' into an
      // exclusion of folder/* — the precise inverse of what the user asked for.
      const manager = await managerWith('!folder/*');

      expect(manager.isExcluded('folder/note.md')).toBe(false);
    });

    it('should apply last-match-wins so a later exclude overrides an earlier negation', async () => {
      const manager = await managerWith(['!folder/*', 'folder/*'].join('\n'));

      expect(manager.isExcluded('folder/note.md')).toBe(true);
    });

    it('should re-exclude on double negation, per gitignore semantics', async () => {
      // '!!x' is two negations = a positive exclude. Prior to the #250 fix, one '!'
      // was eaten by the manual strip and the other reached Minimatch, so '!!x' was
      // the documented workaround for negation being broken. That workaround now
      // correctly inverts back to an exclusion.
      const manager = await managerWith(['*', '!!folder/*'].join('\n'));

      expect(manager.isExcluded('folder/note.md')).toBe(true);
    });
  });

  describe('pattern matching', () => {
    it('should exclude a top-level file matching a wildcard extension pattern', async () => {
      const manager = await managerWith('*.secret');

      expect(manager.isExcluded('creds.secret')).toBe(true);
    });

    it('should not exclude a non-matching file', async () => {
      const manager = await managerWith('*.secret');

      expect(manager.isExcluded('notes.md')).toBe(false);
    });

    // A slash-less pattern matches at any depth in gitignore. Handing '*.secret' to
    // Minimatch raw only matched the top level, so a user following the plugin's own
    // shipped template ("*.secret # All files ending with .secret in any directory")
    // believed nested secrets were hidden while they were still being served.
    it('should exclude a nested file matching a slash-less pattern', async () => {
      const manager = await managerWith('*.secret');

      expect(manager.isExcluded('nested/deeply/creds.secret')).toBe(true);
    });

    it('should exclude the directory node itself for a trailing-slash pattern', async () => {
      const manager = await managerWith('private/');

      expect(manager.isExcluded('private')).toBe(true);
    });

    // 'private/' must imply 'private/**'. No consumer of isExcluded() checks ancestors —
    // every caller passes a full file path — so if the contents are not matched here,
    // they are not excluded anywhere.
    it('should exclude the contents of a trailing-slash directory pattern', async () => {
      const manager = await managerWith('private/');

      expect(manager.isExcluded('private/notes.md')).toBe(true);
      expect(manager.isExcluded('private/deeply/nested/notes.md')).toBe(true);
    });

    it('should exclude a nested directory matching a slash-less directory pattern', async () => {
      const manager = await managerWith('private/');

      expect(manager.isExcluded('work/private/notes.md')).toBe(true);
    });

    it('should anchor a pattern that contains a slash to the vault root', async () => {
      const manager = await managerWith('work/private/');

      expect(manager.isExcluded('work/private/notes.md')).toBe(true);
      expect(manager.isExcluded('other/work/private/notes.md')).toBe(false);
    });

    it('should anchor a leading-slash pattern to the vault root only', async () => {
      const manager = await managerWith('/private/');

      expect(manager.isExcluded('private/notes.md')).toBe(true);
      expect(manager.isExcluded('work/private/notes.md')).toBe(false);
    });

    it('should normalize leading slashes and backslashes before matching', async () => {
      const manager = await managerWith('private/');

      expect(manager.isExcluded('/private/notes.md')).toBe(true);
      expect(manager.isExcluded('private\\notes.md')).toBe(true);
    });

    // BEHAVIOUR CHANGE: a bare '*' has no slash, so gitignore matches it at every depth
    // — it excludes the whole vault, which is what makes the '*' + '!keep/' whitelist
    // idiom work. Previously '*' only matched top-level entries.
    it('should treat a bare * as excluding every depth', async () => {
      const manager = await managerWith('*');

      expect(manager.isExcluded('top.md')).toBe(true);
      expect(manager.isExcluded('folder/note.md')).toBe(true);
      expect(manager.isExcluded('a/b/c/deep.md')).toBe(true);
    });

    it('should support the whitelist idiom: exclude everything, re-include one folder', async () => {
      const manager = await managerWith(['*', '!folder/**'].join('\n'));

      expect(manager.isExcluded('folder/note.md')).toBe(false);
      expect(manager.isExcluded('folder/deeply/nested/note.md')).toBe(false);
      expect(manager.isExcluded('elsewhere/note.md')).toBe(true);
    });
  });

  describe('parsing', () => {
    it('should ignore comments and blank lines', async () => {
      const manager = await managerWith(['# a comment', '', '   ', '*.secret'].join('\n'));

      expect(manager.getPatterns()).toEqual(['*.secret']);
    });

    it('should retain the leading ! in the reported pattern list', async () => {
      const manager = await managerWith(['*', '!folder/*'].join('\n'));

      expect(manager.getPatterns()).toEqual(['*', '!folder/*']);
    });

    it('should exclude nothing when disabled', async () => {
      const manager = await managerWith('**');
      manager.setEnabled(false);

      expect(manager.isExcluded('folder/note.md')).toBe(false);
    });
  });
});
