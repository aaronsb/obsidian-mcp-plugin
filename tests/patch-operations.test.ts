import { ObsidianAPI } from '../src/utils/obsidian-api';
import { SemanticRouter } from '../src/semantic/router';
import { App, TFile } from 'obsidian';

// Mock the instanceof check for TFile
jest.mock('obsidian', () => {
  const originalModule = jest.requireActual('../tests/__mocks__/obsidian');
  return {
    ...originalModule,
    TFile: class TFile {
      static [Symbol.hasInstance](instance: any) {
        return instance && instance._isTFile;
      }
    }
  };
});

describe('Patch Operations', () => {
  let api: ObsidianAPI;
  let mockApp: App;
  let mockFile: any;
  let mockVault: any;

  beforeEach(() => {
    // Create minimal mocks for testing
    mockFile = {
      path: 'test.md',
      name: 'test.md',
      extension: 'md',
      _isTFile: true // Mark as TFile for instanceof check
    };

    mockVault = {
      getAbstractFileByPath: jest.fn().mockReturnValue(mockFile),
      read: jest.fn(),
      modify: jest.fn().mockResolvedValue(undefined)
    };

    mockApp = {
      vault: mockVault
    } as any;

    api = new ObsidianAPI(mockApp);
  });

  describe('Structured Patch - Heading', () => {
    it('should append content to a heading section', async () => {
      const originalContent = `# Main Title

## Section One
Original content here.

## Section Two
Different content.`;

      const expectedContent = `# Main Title

## Section One
Original content here.


New appended content.
## Section Two
Different content.`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'heading',
        target: 'Section One',
        operation: 'append',
        content: 'New appended content.'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });

    it('should prepend content after a heading', async () => {
      const originalContent = `# Main Title

## Section One
Original content here.`;

      const expectedContent = `# Main Title

## Section One

New prepended content.
Original content here.`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'heading',
        target: 'Section One',
        operation: 'prepend',
        content: 'New prepended content.'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });

    it('should handle nested headings with :: syntax', async () => {
      const originalContent = `# Main Title

## Section One

### Subsection
Original subsection content.

## Section Two`;

      const expectedContent = `# Main Title

## Section One

### Subsection
Original subsection content.


New content in subsection.
## Section Two`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'heading',
        target: 'Section One::Subsection',
        operation: 'append',
        content: 'New content in subsection.'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });
  });

  describe('Structured Patch - Frontmatter', () => {
    it('should add a new frontmatter field', async () => {
      const originalContent = `---
title: Test Document
---

# Content`;

      const expectedContent = `---
title: Test Document
status: published
---

# Content`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'frontmatter',
        target: 'status',
        operation: 'replace',
        content: 'published'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });

    it('should create frontmatter if it does not exist', async () => {
      const originalContent = `# Content without frontmatter`;

      const expectedContent = `---
tags: new-tag
---

# Content without frontmatter`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'frontmatter',
        target: 'tags',
        operation: 'replace',
        content: 'new-tag'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });

    // #344: a '---' horizontal rule in the body is not frontmatter.
    it('creates frontmatter at the top when the body has one --- rule', async () => {
      const body = `# Notes\n\nIntro\n\n---\n\nstatus: keep me\nLast line`;
      mockVault.read.mockResolvedValue(body);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'frontmatter',
        target: 'status',
        operation: 'replace',
        content: 'done'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, `---\nstatus: done\n---\n\n${body}`);
      const written: string = mockVault.modify.mock.calls[0][1];
      expect(written.slice(written.indexOf('\n---\n\n') + 6)).toBe(body);
    });

    it('creates frontmatter at the top when the body has two --- rules', async () => {
      const body = `# Notes\n\n---\nstatus: draft\ntitle: body text\n---\n\nEnd`;
      mockVault.read.mockResolvedValue(body);

      for (const operation of ['replace', 'append']) {
        mockVault.modify.mockClear();
        const result = await api.patchVaultFile('test.md', {
          targetType: 'frontmatter',
          target: operation === 'replace' ? 'status' : 'tags',
          operation,
          content: 'done'
        });

        const field = operation === 'replace' ? 'status' : 'tags';
        expect(result.success).toBe(true);
        expect(mockVault.modify).toHaveBeenCalledWith(mockFile, `---\n${field}: done\n---\n\n${body}`);
        const written: string = mockVault.modify.mock.calls[0][1];
        expect(written.slice(written.indexOf('\n---\n\n') + 6)).toBe(body);
      }
    });

    it('edits real frontmatter and leaves a later --- rule in the body alone', async () => {
      mockVault.read.mockResolvedValue('---\nstatus: draft\n---\n# A\n\n---\n\nstatus: body');

      await api.patchVaultFile('test.md', {
        targetType: 'frontmatter',
        target: 'status',
        operation: 'replace',
        content: 'done'
      });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, '---\nstatus: done\n---\n# A\n\n---\n\nstatus: body');
    });

    it('throws without writing when the opening --- has no closing line', async () => {
      mockVault.read.mockResolvedValue('---\nstatus: draft\n# A\nbody');

      await expect(api.patchVaultFile('test.md', {
        targetType: 'frontmatter',
        target: 'status',
        operation: 'replace',
        content: 'done'
      })).rejects.toThrow('never closed');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });
  });

  describe('Structured Patch - Block', () => {
    it('should append content to a block', async () => {
      const originalContent = `# Document

This is a paragraph with a block ID. ^myblock

Another paragraph.`;

      const expectedContent = `# Document

This is a paragraph with a block ID. Additional content ^myblock

Another paragraph.`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        targetType: 'block',
        target: 'myblock',
        operation: 'append',
        content: 'Additional content'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });
  });

  describe('Legacy Patch Operations', () => {
    it('should still support old text replacement', async () => {
      const originalContent = `This is the original text.`;
      const expectedContent = `This is the modified text.`;

      mockVault.read.mockResolvedValue(originalContent);

      const result = await api.patchVaultFile('test.md', {
        operation: 'replace',
        old_text: 'original',
        new_text: 'modified'
      });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, expectedContent);
    });
  });
  // #327: a patch that matched nothing used to write the file back unchanged
  // and report success. Every unresolvable request must now throw before any write.
  describe('Text Replacement and Failure Modes (#327)', () => {
    it('replaces oldText with newText when no operation is given', async () => {
      mockVault.read.mockResolvedValue('alpha\nbeta\ngamma');

      const result = await api.patchVaultFile('test.md', { old_text: 'beta', new_text: 'BETA' });

      expect(result.success).toBe(true);
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nBETA\ngamma');
    });

    it('deletes oldText when newText is empty', async () => {
      mockVault.read.mockResolvedValue('keep remove keep');

      await api.patchVaultFile('test.md', { operation: 'replace', old_text: ' remove', new_text: '' });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'keep keep');
    });

    it('inserts newText literally, without expanding $ replacement patterns', async () => {
      mockVault.read.mockResolvedValue('price: TBD');

      await api.patchVaultFile('test.md', { old_text: 'TBD', new_text: '$& and $1 and $$5' });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'price: $& and $1 and $$5');
    });

    it('throws without writing when oldText is not in the file', async () => {
      mockVault.read.mockResolvedValue('alpha\nbeta');

      await expect(api.patchVaultFile('test.md', { old_text: 'delta', new_text: 'DELTA' }))
        .rejects.toThrow('oldText not found in test.md');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('throws without writing when oldText is given without newText', async () => {
      mockVault.read.mockResolvedValue('alpha');

      await expect(api.patchVaultFile('test.md', { old_text: 'alpha' }))
        .rejects.toThrow("'newText'");
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('throws without writing when neither a target nor oldText is given', async () => {
      mockVault.read.mockResolvedValue('alpha');

      await expect(api.patchVaultFile('test.md', { content: 'x' }))
        .rejects.toThrow('edit.patch needs');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('throws without writing when targetType is given without target', async () => {
      mockVault.read.mockResolvedValue('# A\nbody');

      await expect(api.patchVaultFile('test.md', { targetType: 'heading', operation: 'append', content: 'x' }))
        .rejects.toThrow("'targetType' and 'target'");
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it.each(['heading', 'block', 'frontmatter'])(
      'throws without writing when a %s patch has no valid operation',
      async (targetType) => {
        mockVault.read.mockResolvedValue('---\nstatus: draft\n---\n# A\nline ^b1');
        const target = { heading: 'A', block: 'b1', frontmatter: 'status' }[targetType];

        await expect(api.patchVaultFile('test.md', { targetType, target, content: 'x' }))
          .rejects.toThrow("'operation'");
        await expect(api.patchVaultFile('test.md', { targetType, target, operation: 'upsert', content: 'x' }))
          .rejects.toThrow("'operation'");
        expect(mockVault.modify).not.toHaveBeenCalled();
      },
    );

    it.each([
      [{ operation: 'insert', text: 'x' }, "requires 'position' and 'text'"],
      [{ operation: 'insert', position: 1 }, "requires 'position' and 'text'"],
      [{ operation: 'insert', position: 9, text: 'x' }, 'outside 0..5'],
      [{ operation: 'insert', position: -1, text: 'x' }, 'outside 0..5'],
      [{ operation: 'delete', start: 0 }, "requires 'start' and 'end'"],
      [{ operation: 'delete', start: 4, end: 1 }, 'not within 0..5'],
      [{ operation: 'delete', start: 0, end: 9 }, 'not within 0..5'],
    ])('throws without writing for legacy %o', async (params, message) => {
      mockVault.read.mockResolvedValue('alpha');

      await expect(api.patchVaultFile('test.md', params)).rejects.toThrow(message);
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('applies legacy insert and delete within range', async () => {
      mockVault.read.mockResolvedValue('abcdef');
      await api.patchVaultFile('test.md', { operation: 'insert', position: 3, text: 'X' });
      expect(mockVault.modify).toHaveBeenLastCalledWith(mockFile, 'abcXdef');

      await api.patchVaultFile('test.md', { operation: 'delete', start: 1, end: 4 });
      expect(mockVault.modify).toHaveBeenLastCalledWith(mockFile, 'aef');
    });

    it('replaces only the first occurrence of oldText', async () => {
      mockVault.read.mockResolvedValue('one two one');

      await api.patchVaultFile('test.md', { old_text: 'one', new_text: 'ONE' });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'ONE two one');
    });

    it.each(['heading', 'block'])(
      'throws without writing when a %s patch has no content',
      async (targetType) => {
        mockVault.read.mockResolvedValue('# A\nkeep me ^b1\n# B\nx');
        const target = { heading: 'A', block: 'b1' }[targetType];

        await expect(api.patchVaultFile('test.md', { targetType, target, operation: 'replace' }))
          .rejects.toThrow("requires 'content'");
        expect(mockVault.modify).not.toHaveBeenCalled();
      },
    );

    it('clears a heading section when content is an explicit empty string', async () => {
      mockVault.read.mockResolvedValue('# A\nold body\n# B\nx');

      await api.patchVaultFile('test.md', { targetType: 'heading', target: 'A', operation: 'replace', content: '' });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, '# A\n\n\n# B\nx');
    });

    it('throws without writing when a structured target and oldText are both given', async () => {
      mockVault.read.mockResolvedValue('# A\nkeep me\n# B\nx');

      await expect(api.patchVaultFile('test.md', {
        targetType: 'heading', target: 'A', operation: 'replace', old_text: 'keep me', new_text: 'new',
      })).rejects.toThrow('not both');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });

    it('treats empty-string optional fields as absent', async () => {
      mockVault.read.mockResolvedValue('alpha beta');

      await api.patchVaultFile('test.md', {
        operation: '', targetType: '', target: '', old_text: 'beta', new_text: 'BETA',
      });

      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'alpha BETA');
    });

    it('reports the failure through the router instead of "Edit successful"', async () => {
      mockVault.read.mockResolvedValue('alpha\nbeta\ngamma');

      const ok = await new SemanticRouter(api).route({
        operation: 'edit',
        action: 'patch',
        params: { path: 'test.md', oldText: 'beta', newText: 'BETA' },
      });
      expect((ok as any).error).toBeFalsy();
      expect(mockVault.modify).toHaveBeenCalledWith(mockFile, 'alpha\nBETA\ngamma');

      mockVault.modify.mockClear();
      const miss = await new SemanticRouter(api).route({
        operation: 'edit',
        action: 'patch',
        params: { path: 'test.md', oldText: 'missing', newText: 'x' },
      });
      expect((miss as any).error?.message ?? (miss as any).error).toContain('oldText not found');
      expect(mockVault.modify).not.toHaveBeenCalled();
    });
  });
});