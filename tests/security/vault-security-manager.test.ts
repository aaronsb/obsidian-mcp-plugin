import { VaultSecurityManager, OperationType, SecuritySettings, DEFAULT_SECURITY_SETTINGS } from '../../src/security/vault-security-manager';
import { SecurityError } from '../../src/security/path-validator';
import { App } from 'obsidian';

// Mock the path validator
jest.mock('../../src/security/path-validator', () => ({
  SecurePathValidator: jest.fn().mockImplementation(() => ({
    validatePath: jest.fn((path: string) => {
      if (path.includes('../')) {
        throw new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN');
      }
      return path;
    })
  })),
  SecurityError: class SecurityError extends Error {
    constructor(message: string, public code: string = 'SECURITY_VIOLATION') {
      super(message);
      this.name = 'SecurityError';
    }
  }
}));

// Mock Debug
jest.mock('../../src/utils/debug', () => ({
  Debug: {
    log: jest.fn(),
    isDebugMode: jest.fn().mockReturnValue(false),
    setDebugMode: jest.fn()
  }
}));

describe('VaultSecurityManager', () => {
  let manager: VaultSecurityManager;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {} as App;
    manager = new VaultSecurityManager(mockApp);
  });

  describe('Operation permission validation', () => {
    test('allows operations when permissions are enabled', async () => {
      const operations = [
        { type: OperationType.READ, path: 'file.md' },
        { type: OperationType.CREATE, path: 'new-file.md' },
        { type: OperationType.UPDATE, path: 'existing.md' },
        { type: OperationType.DELETE, path: 'old.md' },
        { type: OperationType.MOVE, path: 'src.md', targetPath: 'dest.md' },
        { type: OperationType.RENAME, path: 'old-name.md', targetPath: 'new-name.md' },
        { type: OperationType.EXECUTE, path: 'script.md' }
      ];

      for (const op of operations) {
        const result = await manager.validateOperation(op);
        expect(result).toMatchObject({
          ...op,
          validatedAt: expect.any(Number)
        });
      }
    });

    test('blocks operations when permissions are disabled', async () => {
      // Create manager with all permissions disabled
      const restrictedSettings: Partial<SecuritySettings> = {
        permissions: {
          read: false,
          create: false,
          update: false,
          delete: false,
          move: false,
          rename: false,
          execute: false
        }
      };
      
      const restrictedManager = new VaultSecurityManager(mockApp, restrictedSettings);

      const operations = [
        { type: OperationType.READ, path: 'file.md' },
        { type: OperationType.CREATE, path: 'new-file.md' },
        { type: OperationType.UPDATE, path: 'existing.md' },
        { type: OperationType.DELETE, path: 'old.md' },
        { type: OperationType.MOVE, path: 'src.md', targetPath: 'dest.md' },
        { type: OperationType.RENAME, path: 'old-name.md', targetPath: 'new-name.md' },
        { type: OperationType.EXECUTE, path: 'script.md' }
      ];

      for (const op of operations) {
        await expect(restrictedManager.validateOperation(op))
          .rejects
          .toThrow(new SecurityError(
            `Operation '${op.type}' is not permitted in current security mode`,
            'PERMISSION_DENIED'
          ));
      }
    });

    test('copy operation requires both read and create permissions', async () => {
      const settings: Partial<SecuritySettings> = {
        permissions: {
          read: true,
          create: false,
          update: true,
          delete: true,
          move: true,
          rename: true,
          execute: true
        }
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);
      
      await expect(manager.validateOperation({
        type: OperationType.COPY,
        path: 'source.md',
        targetPath: 'dest.md'
      })).rejects.toThrow(SecurityError);

      // Now enable create
      settings.permissions!.create = true;
      manager.updateSettings(settings);
      
      const result = await manager.validateOperation({
        type: OperationType.COPY,
        path: 'source.md',
        targetPath: 'dest.md'
      });
      
      expect(result).toBeDefined();
    });
  });

  describe('Path validation integration', () => {
    test('validates paths through SecurePathValidator', async () => {
      const operation = {
        type: OperationType.READ,
        path: 'notes/file.md'
      };

      const result = await manager.validateOperation(operation);
      expect(result.path).toBe('notes/file.md');
    });

    test('rejects operations with dangerous paths', async () => {
      const operation = {
        type: OperationType.READ,
        path: '../../../etc/passwd'
      };

      await expect(manager.validateOperation(operation))
        .rejects
        .toThrow(SecurityError);
    });

    test('validates both source and target paths for move operations', async () => {
      const operation = {
        type: OperationType.MOVE,
        path: 'source.md',
        targetPath: 'dest.md'
      };

      const result = await manager.validateOperation(operation);
      expect(result.path).toBe('source.md');
      expect(result.targetPath).toBe('dest.md');
    });
  });

  describe('Path allow/block lists', () => {
    test('blocks paths matching blocklist patterns', async () => {
      const settings: Partial<SecuritySettings> = {
        blockedPaths: ['private/*', '*.secret', 'config/sensitive.md']
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      const blockedPaths = [
        'private/diary.md',
        'private/notes/personal.md',
        'passwords.secret',
        'config/sensitive.md'
      ];

      for (const path of blockedPaths) {
        await expect(manager.validateOperation({
          type: OperationType.READ,
          path
        })).rejects.toThrow(new SecurityError(
          `Access to path '${path}' is blocked`,
          'PATH_BLOCKED'
        ));
      }
    });

    test('allows only paths matching allowlist when specified', async () => {
      const settings: Partial<SecuritySettings> = {
        allowedPaths: ['notes/*', 'tasks/*.md']
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      // These should be allowed
      const allowedPaths = ['notes/daily.md', 'notes/ideas.md', 'tasks/todo.md'];
      for (const path of allowedPaths) {
        const result = await manager.validateOperation({
          type: OperationType.READ,
          path
        });
        expect(result.path).toBe(path);
      }

      // These should be blocked
      const blockedPaths = ['private/diary.md', 'config/settings.md'];
      for (const path of blockedPaths) {
        await expect(manager.validateOperation({
          type: OperationType.READ,
          path
        })).rejects.toThrow(SecurityError);
      }
    });
  });

  describe('Sandbox mode', () => {
    test('restricts all operations to sandbox directory', async () => {
      const settings: Partial<SecuritySettings> = {
        sandboxMode: 'sandbox'
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      // Allowed - within sandbox
      const result = await manager.validateOperation({
        type: OperationType.CREATE,
        path: 'sandbox/file.md'
      });
      expect(result.path).toBe('sandbox/file.md');

      // Blocked - outside sandbox
      await expect(manager.validateOperation({
        type: OperationType.CREATE,
        path: 'outside/file.md'
      })).rejects.toThrow(new SecurityError(
        'Path must be within sandbox: sandbox',
        'SANDBOX_VIOLATION'
      ));
    });

    test('validates target paths in sandbox mode', async () => {
      const settings: Partial<SecuritySettings> = {
        sandboxMode: 'sandbox'
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      await expect(manager.validateOperation({
        type: OperationType.MOVE,
        path: 'sandbox/source.md',
        targetPath: 'outside/dest.md'
      })).rejects.toThrow(new SecurityError(
        'Target path must be within sandbox: sandbox',
        'SANDBOX_VIOLATION'
      ));
    });
  });

  describe('Security presets', () => {
    test('readOnly preset blocks all write operations', () => {
      const readOnlySettings = VaultSecurityManager.presets.readOnly();
      expect(readOnlySettings.permissions).toEqual({
        read: true,
        create: false,
        update: false,
        delete: false,
        move: false,
        rename: false,
        execute: false
      });
    });

    // execute was true here, and that was correct while EXECUTE meant openFile.
    // EXECUTE now means running an arbitrary Obsidian command by id, and the
    // command palette contains "Delete current file" — so under the new meaning
    // execute:true would let safeMode authorise what its delete:false is for.
    // The permission's meaning moved, so the expectation moved with it.
    test('safeMode preset allows reorganisation but neither delete nor execute', () => {
      const safeModeSettings = VaultSecurityManager.presets.safeMode();
      expect(safeModeSettings.permissions).toEqual({
        read: true,
        create: true,
        update: true,
        delete: false,
        move: true,
        rename: true,
        execute: false
      });
    });

    test('fullAccess preset allows all operations', () => {
      const fullAccessSettings = VaultSecurityManager.presets.fullAccess();
      expect(fullAccessSettings.permissions).toEqual({
        read: true,
        create: true,
        update: true,
        delete: true,
        move: true,
        rename: true,
        execute: true
      });
    });
  });

  describe('Audit logging', () => {
    test('logs security events when enabled', async () => {
      const operation = {
        type: OperationType.READ,
        path: 'file.md'
      };

      await manager.validateOperation(operation);
      
      const log = manager.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        timestamp: expect.any(Number),
        operation,
        result: 'allowed'
      });
    });

    test('logs blocked operations with reasons', async () => {
      const settings: Partial<SecuritySettings> = {
        blockedPaths: ['secret/*']
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      try {
        await manager.validateOperation({
          type: OperationType.READ,
          path: 'secret/passwords.md'
        });
      } catch (e) {
        // Expected to throw
      }

      const log = manager.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        result: 'blocked',
        reason: 'PATH_BLOCKED'
      });
    });

    test('maintains log size limit', async () => {
      // Create many operations to exceed limit
      for (let i = 0; i < 1100; i++) {
        await manager.validateOperation({
          type: OperationType.READ,
          path: `file${i}.md`
        });
      }

      const log = manager.getAuditLog();
      expect(log.length).toBeLessThanOrEqual(1000);
    });

    test('can clear audit log', async () => {
      await manager.validateOperation({
        type: OperationType.READ,
        path: 'file.md'
      });

      expect(manager.getAuditLog()).toHaveLength(1);
      
      manager.clearAuditLog();
      expect(manager.getAuditLog()).toHaveLength(0);
    });
  });

  describe('Settings management', () => {
    test('updates settings correctly', () => {
      const newSettings: Partial<SecuritySettings> = {
        pathValidation: 'moderate',
        permissions: {
          ...DEFAULT_SECURITY_SETTINGS.permissions,
          delete: false
        }
      };

      manager.updateSettings(newSettings);
      const current = manager.getSettings();
      
      expect(current.pathValidation).toBe('moderate');
      expect(current.permissions.delete).toBe(false);
      expect(current.permissions.read).toBe(true); // Unchanged
    });

    test('returns copy of settings to prevent external modification', () => {
      const settings = manager.getSettings();
      settings.permissions.read = false;
      
      // Original should be unchanged
      const current = manager.getSettings();
      expect(current.permissions.read).toBe(true);
    });
  });

  describe('Path validation disabled mode', () => {
    test('skips path validation when disabled but checks permissions', async () => {
      const settings: Partial<SecuritySettings> = {
        pathValidation: 'disabled',
        permissions: {
          read: true,   // Keep read enabled for first test
          create: true,
          update: true,
          delete: false, // Disable delete for second test
          move: true,
          rename: true,
          execute: true
        }
      };
      
      const manager = new VaultSecurityManager(mockApp, settings);

      // This should pass even with dangerous path because validation is disabled
      const result = await manager.validateOperation({
        type: OperationType.READ,
        path: '../../../etc/passwd'
      });
      
      expect(result.path).toBe('../../../etc/passwd');

      // But permission check should still work
      await expect(manager.validateOperation({
        type: OperationType.DELETE,
        path: 'file.md'
      })).rejects.toThrow(new SecurityError(
        "Operation 'delete' is not permitted",
        'PERMISSION_DENIED'
      ));
    });
  });
});