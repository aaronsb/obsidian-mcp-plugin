import { MCPHttpServer, MAX_RECOVERY_ATTEMPTS, RECOVERY_BACKOFF_MS, retryWithBackoff } from '../src/mcp-server';
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

  describe('retryWithBackoff', () => {
    test('returns result on first attempt when fn succeeds immediately', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await retryWithBackoff(fn, {
        maxAttempts: 3,
        backoffMs: 10,
        shouldRetry: (r) => r !== 'ok'
      });
      expect(result).toEqual({ result: 'ok', attempts: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries and succeeds on second attempt', async () => {
      const fn = jest.fn()
        .mockResolvedValueOnce('fail')
        .mockResolvedValue('ok');
      const result = await retryWithBackoff(fn, {
        maxAttempts: 3,
        backoffMs: 10,
        shouldRetry: (r) => r !== 'ok'
      });
      expect(result).toEqual({ result: 'ok', attempts: 2 });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('returns null after exhausting all attempts', async () => {
      const fn = jest.fn().mockResolvedValue('fail');
      const result = await retryWithBackoff(fn, {
        maxAttempts: MAX_RECOVERY_ATTEMPTS,
        backoffMs: 10,
        shouldRetry: (r) => r === 'fail'
      });
      expect(result).toBeNull();
      expect(fn).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
    });

    test('applies linear backoff between attempts', async () => {
      const timestamps: number[] = [];
      const fn = jest.fn().mockImplementation(async () => {
        timestamps.push(Date.now());
        return timestamps.length < 3 ? 'fail' : 'ok';
      });
      await retryWithBackoff(fn, {
        maxAttempts: 3,
        backoffMs: RECOVERY_BACKOFF_MS,
        shouldRetry: (r) => r !== 'ok'
      });
      // Second attempt should have ~500ms delay, third ~1000ms
      const gap1 = timestamps[1] - timestamps[0];
      const gap2 = timestamps[2] - timestamps[1];
      expect(gap1).toBeGreaterThanOrEqual(400);  // 500ms with some tolerance
      expect(gap2).toBeGreaterThanOrEqual(900);  // 1000ms with some tolerance
      expect(gap2).toBeGreaterThan(gap1);         // linear increase
    });
  });
});