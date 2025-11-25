import { ObsidianAPI } from '../src/utils/obsidian-api';
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
});