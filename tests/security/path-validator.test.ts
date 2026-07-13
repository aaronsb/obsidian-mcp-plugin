import { SecurePathValidator, TypeSafePathValidator, SecurityError } from '../../src/security/path-validator';
import { App, normalizePath } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';

// Mock Obsidian
jest.mock('obsidian', () => ({
  normalizePath: jest.fn((p: string) => p.replace(/\\/g, '/'))
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  realpathSync: jest.fn()
}));

// Mock path module
jest.mock('path', () => ({
  resolve: jest.fn(),
  normalize: jest.fn(),
  relative: jest.fn(),
  join: jest.fn(),
  sep: '/'
}));

describe('SecurePathValidator', () => {
  let validator: SecurePathValidator;
  let mockApp: any;
  const mockBaseDir = '/home/user/vault';

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mock app
    mockApp = {
      vault: {
        adapter: {
          basePath: mockBaseDir
        }
      }
    };

    // Setup default mock implementations
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (path.normalize as jest.Mock).mockImplementation((p: string) => p);
    (path.resolve as jest.Mock).mockImplementation((base: string, userPath: string) => `${base}/${userPath}`);
    (path.relative as jest.Mock).mockImplementation((from: string, to: string) => {
      // Simple relative path calculation for testing
      if (to.startsWith(from)) {
        return to.substring(from.length + 1);
      }
      return to;
    });
    
    validator = new SecurePathValidator(mockApp as App);
  });

  describe('Basic path validation', () => {
    test('accepts valid relative paths', () => {
      const validPaths = [
        'notes/daily.md',
        'folder/subfolder/file.md',
        'file.md',
        'deep/nested/folder/structure/file.txt'
      ];

      validPaths.forEach(path => {
        expect(() => validator.validatePath(path)).not.toThrow();
        const result = validator.validatePath(path);
        expect(result).toBe(path);
      });
    });

    test('rejects null or empty paths', () => {
      expect(() => validator.validatePath('')).toThrow(SecurityError);
      expect(() => validator.validatePath(null as any)).toThrow(SecurityError);
      expect(() => validator.validatePath(undefined as any)).toThrow(SecurityError);
    });

    test('rejects non-string paths', () => {
      expect(() => validator.validatePath(123 as any)).toThrow(SecurityError);
      expect(() => validator.validatePath({} as any)).toThrow(SecurityError);
      expect(() => validator.validatePath([] as any)).toThrow(SecurityError);
    });
  });

  describe('Path traversal prevention', () => {
    test('rejects basic directory traversal', () => {
      const traversalPaths = [
        '../file.md',
        '../../file.md',
        '../../../etc/passwd',
        'folder/../../../file.md',
        './../../file.md'
      ];

      traversalPaths.forEach(path => {
        expect(() => validator.validatePath(path))
          .toThrow(new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN'));
      });
    });

    test('rejects encoded traversal attempts', () => {
      const encodedPaths = [
        '%2e%2e%2ffile.md',
        '%2e%2e%5cfile.md',
        '%252e%252e%252ffile.md',
        '..%2ffile.md',
        '.%2e/file.md'
      ];

      encodedPaths.forEach(path => {
        expect(() => validator.validatePath(path))
          .toThrow(new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN'));
      });
    });

    test('rejects unicode traversal attempts', () => {
      const unicodePaths = [
        '\u002e\u002e\u002ffile.md',
        '\u002e\u002e\u005cfile.md'
      ];

      unicodePaths.forEach(path => {
        expect(() => validator.validatePath(path))
          .toThrow(new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN'));
      });
    });

    test('rejects null byte injection', () => {
      const nullBytePaths = [
        'file.md\0.txt',
        'file.md%00.txt',
        'folder\0/file.md'
      ];

      nullBytePaths.forEach(path => {
        expect(() => validator.validatePath(path))
          .toThrow(new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN'));
      });
    });

    test('rejects Windows UNC paths', () => {
      const uncPaths = [
        '\\\\server\\share\\file.md',
        '//server/share/file.md'
      ];

      uncPaths.forEach(path => {
        expect(() => validator.validatePath(path))
          .toThrow(new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN'));
      });
    });
  });

  describe('Absolute path prevention', () => {
    test('rejects Unix absolute paths', () => {
      expect(() => validator.validatePath('/etc/passwd'))
        .toThrow(new SecurityError('Absolute paths are not allowed', 'ABSOLUTE_PATH'));
      expect(() => validator.validatePath('/home/user/file.md'))
        .toThrow(new SecurityError('Absolute paths are not allowed', 'ABSOLUTE_PATH'));
    });

    test('rejects Windows absolute paths', () => {
      expect(() => validator.validatePath('C:\\Windows\\System32'))
        .toThrow(new SecurityError('Absolute paths are not allowed', 'ABSOLUTE_PATH'));
      expect(() => validator.validatePath('D:\\file.txt'))
        .toThrow(new SecurityError('Absolute paths are not allowed', 'ABSOLUTE_PATH'));
    });

    test('rejects URL-style paths', () => {
      // URL paths are caught by the dangerous patterns check
      expect(() => validator.validatePath('file:///etc/passwd'))
        .toThrow(SecurityError);
      expect(() => validator.validatePath('http://example.com/file'))
        .toThrow(SecurityError);
    });
  });

  describe('Vault boundary enforcement', () => {
    test('ensures paths stay within vault after normalization', () => {
      // Use a path without traversal patterns that only fails at vault boundary check
      const testPath = 'outside.md';
      (path.resolve as jest.Mock).mockReturnValue('/home/user/outside.md');
      
      expect(() => validator.validatePath(testPath))
        .toThrow(new SecurityError('Path escapes vault boundary', 'VAULT_ESCAPE'));
    });

    test('allows paths that stay within vault', () => {
      // Mock path operations to stay within vault
      (path.resolve as jest.Mock).mockReturnValue(`${mockBaseDir}/notes/file.md`);
      (path.relative as jest.Mock).mockReturnValue('notes/file.md');

      const result = validator.validatePath('notes/file.md');
      expect(result).toBe('notes/file.md');
    });
  });

  describe('Symlink attack prevention', () => {
    test('symlink validation behavior', () => {
      // The symlink check is a layer 8 validation that prevents symlink escapes
      // when files exist. For non-existent files, it's not triggered.
      // This test verifies the function exists and doesn't break normal operation
      const symlinkPath = 'potential-symlink.md';
      
      // For non-existent files, validation should pass basic checks
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (path.resolve as jest.Mock).mockReturnValue(`${mockBaseDir}/potential-symlink.md`);
      (path.relative as jest.Mock).mockReturnValue('potential-symlink.md');
      
      const result = validator.validatePath(symlinkPath);
      expect(result).toBe('potential-symlink.md');
    });
  });

  describe('Edge cases', () => {
    test('handles paths with special characters', () => {
      const specialPaths = [
        'notes/file with spaces.md',
        'folder/file-with-dashes.md',
        'folder/file_with_underscores.md',
        'folder/file.multiple.dots.md'
      ];

      specialPaths.forEach(path => {
        expect(() => validator.validatePath(path)).not.toThrow();
      });
    });

    test('rejects paths that normalize to parent directory references', () => {
      // Mock relative path to return parent directory reference
      (path.relative as jest.Mock).mockReturnValue('../escape.md');
      
      expect(() => validator.validatePath('some/path.md'))
        .toThrow(new SecurityError('Invalid relative path', 'INVALID_RELATIVE'));
    });

    test('handles empty vault base directory gracefully', () => {
      const emptyBaseApp = {
        vault: {
          adapter: {
            basePath: ''
          }
        }
      };

      expect(() => new SecurePathValidator(emptyBaseApp as any))
        .toThrow('Could not determine vault base directory');
    });
  });

  describe('getBaseDir', () => {
    test('returns the vault base directory', () => {
      expect(validator.getBaseDir()).toBe(mockBaseDir);
    });
  });
});

describe('TypeSafePathValidator', () => {
  // The branded ValidatedPath return type is compile-time only, but the class is a real
  // SecurePathValidator subclass and must still enforce the boundary at runtime — that
  // part is testable, and is what actually protects the vault.
  let validator: TypeSafePathValidator;
  const mockBaseDir = '/home/user/vault';

  beforeEach(() => {
    jest.clearAllMocks();

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (path.normalize as jest.Mock).mockImplementation((p: string) => p);
    (path.resolve as jest.Mock).mockImplementation((base: string, userPath: string) => `${base}/${userPath}`);
    (path.relative as jest.Mock).mockImplementation((from: string, to: string) =>
      to.startsWith(from) ? to.substring(from.length + 1) : to
    );

    const mockApp = { vault: { adapter: { basePath: mockBaseDir } } };
    validator = new TypeSafePathValidator(mockApp as unknown as App);
  });

  test('returns the validated path for a legitimate input', () => {
    expect(validator.validatePath('notes/daily.md')).toBe('notes/daily.md');
  });

  test('still rejects directory traversal inherited from SecurePathValidator', () => {
    expect(() => validator.validatePath('../../etc/passwd')).toThrow(SecurityError);
  });

  test('still rejects empty paths', () => {
    expect(() => validator.validatePath('')).toThrow(SecurityError);
  });
});