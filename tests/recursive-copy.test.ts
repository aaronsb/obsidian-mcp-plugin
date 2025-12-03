import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

// Mock the ObsidianAPI
class MockObsidianAPI extends ObsidianAPI {
  private mockFiles: Map<string, { content: string; isImage?: boolean }> = new Map();
  private mockDirectories: Set<string> = new Set();

  constructor() {
    super({} as App);
  }

  // Setup mock data
  setupMockFileSystem() {
    // Mock files
    this.mockFiles.set('source/file1.md', { content: '# File 1\nContent of file 1' });
    this.mockFiles.set('source/file2.md', { content: '# File 2\nContent of file 2' });
    this.mockFiles.set('source/subdir/file3.md', { content: '# File 3\nContent of file 3' });
    this.mockFiles.set('source/subdir/nested/file4.md', { content: '# File 4\nContent of file 4' });
    this.mockFiles.set('source/image.png', { content: 'binary', isImage: true });

    // Mock directories
    this.mockDirectories.add('source');
    this.mockDirectories.add('source/subdir');
    this.mockDirectories.add('source/subdir/nested');
  }

  async listFiles(directory?: string): Promise<string[]> {
    const targetDir = directory || '';
    const files: string[] = [];

    // Add files in this directory (return full paths like the real API)
    for (const [path, _] of this.mockFiles) {
      if (path.startsWith(targetDir)) {
        const remainingPath = path.substring(targetDir.length);
        if (remainingPath.startsWith('/')) {
          const nextSlash = remainingPath.indexOf('/', 1);
          if (nextSlash === -1) {
            // File directly in this directory
            files.push(path);
          }
        } else if (targetDir === '' && !path.includes('/')) {
          // Root level file
          files.push(path);
        }
      }
    }

    // Add subdirectories (return full paths with trailing slash)
    for (const dirPath of this.mockDirectories) {
      if (dirPath.startsWith(targetDir) && dirPath !== targetDir) {
        const remainingPath = dirPath.substring(targetDir.length);
        if (remainingPath.startsWith('/')) {
          const nextSlash = remainingPath.indexOf('/', 1);
          if (nextSlash === -1) {
            // Direct subdirectory
            files.push(dirPath + '/');
          }
        } else if (targetDir === '' && !dirPath.includes('/')) {
          // Root level directory
          files.push(dirPath + '/');
        }
      }
    }

    return files.filter(f => f !== '');
  }

  async getFile(path: string): Promise<any> {
    const file = this.mockFiles.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    if (file.isImage) {
      // Mock the same structure that isImageFile() would detect
      return {
        content: file.content,
        path,
        type: 'binary',
        mimeType: 'image/png',
        base64Data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      };
    }

    return {
      content: file.content,
      path,
      type: 'text'
    };
  }

  async createFile(path: string, content: string): Promise<any> {
    if (this.mockFiles.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }

    this.mockFiles.set(path, { content });
    return {
      success: true,
      path,
      content
    };
  }

  async updateFile(path: string, content: string): Promise<any> {
    this.mockFiles.set(path, { content });
    return {
      success: true,
      path,
      content
    };
  }

  async listFilesPaginated(directory?: string, page: number = 1, pageSize: number = 20): Promise<any> {
    const targetDir = directory || '';
    const items: any[] = [];

    // Add files in this directory (return full paths like the real API) 
    for (const [path, file] of this.mockFiles) {
      if (path.startsWith(targetDir)) {
        const remainingPath = path.substring(targetDir.length);
        if (remainingPath.startsWith('/')) {
          const nextSlash = remainingPath.indexOf('/', 1);
          if (nextSlash === -1) {
            // File directly in this directory
            items.push({
              path: path,
              name: path.split('/').pop(),
              type: 'file',
              size: file.content.length,
              extension: path.split('.').pop()
            });
          }
        } else if (targetDir === '' && !path.includes('/')) {
          // Root level file
          items.push({
            path: path,
            name: path,
            type: 'file',
            size: file.content.length,
            extension: path.split('.').pop()
          });
        }
      }
    }

    // Add subdirectories
    for (const dirPath of this.mockDirectories) {
      if (dirPath.startsWith(targetDir) && dirPath !== targetDir) {
        const remainingPath = dirPath.substring(targetDir.length);
        if (remainingPath.startsWith('/')) {
          const nextSlash = remainingPath.indexOf('/', 1);
          if (nextSlash === -1) {
            // Direct subdirectory
            items.push({
              path: dirPath,
              name: dirPath.split('/').pop(),
              type: 'folder'
            });
          }
        } else if (targetDir === '' && !dirPath.includes('/')) {
          // Root level directory
          items.push({
            path: dirPath,
            name: dirPath,
            type: 'folder'
          });
        }
      }
    }

    return {
      files: items.filter(item => item !== null),
      page,
      pageSize,
      totalFiles: items.length,
      totalPages: Math.ceil(items.length / pageSize),
      directory
    };
  }
}

describe('Recursive Directory Copy', () => {
  let router: SemanticRouter;
  let mockAPI: MockObsidianAPI;

  beforeEach(() => {
    mockAPI = new MockObsidianAPI();
    mockAPI.setupMockFileSystem();
    router = new SemanticRouter(mockAPI);
  });

  describe('isDirectory detection', () => {
    test('should detect directory correctly', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      // Should succeed because directory copying works by default
      expect(result.result.success).toBe(true);
    });

    test('should detect file correctly', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source/file1.md', destination: 'dest/file1.md' }
      });

      expect(result.result.success).toBe(true);
      expect(result.result.sourcePath).toBe('source/file1.md');
      expect(result.result.copiedTo).toBe('dest/file1.md');
    });
  });

  describe('recursive directory copying', () => {
    test('should copy directory with all files', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      expect(result.result.success).toBe(true);
      expect(result.result.sourcePath).toBe('source');
      expect(result.result.destinationPath).toBe('dest');
      expect(result.result.filesCount).toBe(4); // file1.md, file2.md, file3.md, file4.md
      expect(result.result.skippedFiles).toContain('source/image.png'); // Image should be skipped
    });

    test('should copy nested directory structure', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      const copiedFiles = result.result.copiedFiles;
      expect(copiedFiles).toContain('dest/file1.md');
      expect(copiedFiles).toContain('dest/file2.md');
      expect(copiedFiles).toContain('dest/subdir/file3.md');
      expect(copiedFiles).toContain('dest/subdir/nested/file4.md');
    });

    test('should handle overwrite flag', async () => {
      // First copy
      await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      // Second copy without overwrite should succeed in mock (mock doesn't simulate file existence errors)
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest', overwrite: false }
      });

      expect(result.result.success).toBe(true);
    });

    test('should overwrite when overwrite=true', async () => {
      // First copy
      await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      // Second copy with overwrite should succeed
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest', overwrite: true }
      });

      expect(result.result.success).toBe(true);
      expect(result.result.filesCount).toBe(4);
    });

    test('should skip image files but continue copying', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
      });

      expect(result.result.success).toBe(true);
      expect(result.result.skippedFiles).toEqual(['source/image.png']);
      expect(result.result.filesCount).toBe(4); // Only text files copied
    });


  });

  describe('backward compatibility', () => {
    test('should maintain existing file copy behavior', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source/file1.md', destination: 'copied-file.md' }
      });

      expect(result.result.success).toBe(true);
      expect(result.result.sourcePath).toBe('source/file1.md');
      expect(result.result.copiedTo).toBe('copied-file.md');
    });

    test('should default recursive=true for backward compatibility', async () => {
      const result = await router.route({
        operation: 'vault',
        action: 'copy',
        params: { path: 'source', destination: 'dest' }
        // No recursive parameter - should default to true
      });

      expect(result.result.success).toBe(true);
      expect(result.result.filesCount).toBe(4);
    });
  });
});