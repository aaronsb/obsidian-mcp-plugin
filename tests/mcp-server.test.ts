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

  // Note: Actual server start/stop tests would require more complex mocking
  // of Express and network interfaces. For now, we test the basic instantiation.
});