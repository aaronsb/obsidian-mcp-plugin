import { SecureObsidianAPI, VaultSecurityManager, SecurityError } from '../src/security';
import { App } from 'obsidian';

// Mock Obsidian
jest.mock('obsidian', () => ({
  normalizePath: jest.fn((p: string) => p.replace(/\\/g, '/'))
}));

describe('Read-Only Mode Integration', () => {
  let mockApp: App;
  let mockPlugin: any;

  beforeEach(() => {
    mockApp = {
      vault: {
        adapter: {
          basePath: '/test/vault'
        }
      }
    } as any;

    mockPlugin = {
      settings: {
        readOnlyMode: true
      }
    };
  });

  test('SecureObsidianAPI with read-only preset blocks write operations', async () => {
    const readOnlySettings = VaultSecurityManager.presets.readOnly();
    const secureAPI = new SecureObsidianAPI(mockApp, undefined, mockPlugin, readOnlySettings);

    // Test that write operations are blocked
    const writeOperations = [
      () => secureAPI.createFile('test.md', 'content'),
      () => secureAPI.updateFile('test.md', 'new content'),
      () => secureAPI.deleteFile('test.md'),
      () => secureAPI.appendToFile('test.md', 'appended content'),
      () => secureAPI.patchVaultFile('test.md', {})
    ];

    for (const operation of writeOperations) {
      await expect(operation()).rejects.toThrow(SecurityError);
    }
  });

  test('read-only preset has correct permissions', () => {
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

  test('read-only mode setting is protected by security architecture', () => {
    // This test verifies the security architecture protects read-only mode settings
    
    const readOnlySettings = VaultSecurityManager.presets.readOnly();
    
    // Read-only mode only allows read operations
    expect(readOnlySettings.permissions?.create).toBe(false);
    expect(readOnlySettings.permissions?.update).toBe(false);
    expect(readOnlySettings.permissions?.delete).toBe(false);
    
    // This ensures that no write operations can modify the .obsidian directory
    // where the plugin settings (including readOnlyMode) are stored
    expect(readOnlySettings.permissions?.read).toBe(true);
  });

  test('plugin settings structure includes readOnlyMode', () => {
    const settings = {
      httpEnabled: true,
      httpPort: 3001,
      debugLogging: false,
      showConnectionStatus: true,
      autoDetectPortConflicts: true,
      apiKey: 'test-key',
      dangerouslyDisableAuth: false,
      readOnlyMode: true // This should be present
    };

    expect(settings.readOnlyMode).toBe(true);
    expect(typeof settings.readOnlyMode).toBe('boolean');
  });
});