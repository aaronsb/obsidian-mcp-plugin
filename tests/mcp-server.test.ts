import { MCPHttpServer } from '../src/mcp-server';
import { App } from 'obsidian';

// Mock the fs module to prevent file system operations in tests
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));

describe('MCPHttpServer', () => {
  let mockApp: App;

  beforeEach(() => {
    mockApp = new App();
    // Mock the vault adapter for the SecurePathValidator
    mockApp.vault = {
      ...mockApp.vault,
      adapter: {
        basePath: '/mock/vault/path'
      }
    } as any;
  });

  describe('instantiation', () => {
    test('should create server instance', () => {
      const server = new MCPHttpServer(mockApp, 3001);
      expect(server).toBeInstanceOf(MCPHttpServer);
      expect(server.getPort()).toBe(3001);
      expect(server.isServerRunning()).toBe(false);
    });

    test('should get correct port', () => {
      const server = new MCPHttpServer(mockApp, 4001);
      expect(server.getPort()).toBe(4001);
    });

    test('should have a start time', () => {
      const before = Date.now();
      const server = new MCPHttpServer(mockApp, 3001);
      const after = Date.now();
      expect(server.getStartTime()).toBeGreaterThanOrEqual(before);
      expect(server.getStartTime()).toBeLessThanOrEqual(after);
    });

    test('should expose session manager', () => {
      const server = new MCPHttpServer(mockApp, 3001);
      // Session manager is created during setupRoutes, which happens in constructor
      // It may or may not be available depending on initialization
      const sm = server.getSessionManager();
      // SessionManager should exist after construction
      expect(sm).toBeDefined();
    });
  });

  // Note: Full HTTP request/response tests require the server to be started,
  // which needs Express and network interfaces. The session recovery logic
  // is tested at the SessionManager level in session-manager.test.ts.
  // Integration tests for the full HTTP flow should be done manually
  // against a running Obsidian instance.
});
