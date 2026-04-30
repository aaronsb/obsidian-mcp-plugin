import { SessionManager } from '../src/utils/session-manager';

// Suppress Debug output during tests
jest.mock('../src/utils/debug', () => ({
  Debug: {
    log: jest.fn(),
    error: jest.fn(),
  },
}));

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({
      maxSessions: 3,
      sessionTimeout: 1000, // 1 second for fast tests
      checkInterval: 60000, // don't auto-run cleanup
    });
  });

  afterEach(() => {
    manager.stop();
  });

  describe('session lifecycle', () => {
    test('getOrCreateSession creates a new session', () => {
      const session = manager.getOrCreateSession('sess-1');
      expect(session.sessionId).toBe('sess-1');
      expect(session.requestCount).toBe(1);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActivityAt).toBe(session.createdAt);
    });

    test('getOrCreateSession returns existing session and increments requestCount', () => {
      manager.getOrCreateSession('sess-1');
      const session = manager.getOrCreateSession('sess-1');
      expect(session.requestCount).toBe(2);
    });

    test('touchSession updates lastActivityAt', () => {
      const session = manager.getOrCreateSession('sess-1');
      const originalActivity = session.lastActivityAt;
      // Small delay to ensure time difference
      manager.touchSession('sess-1');
      expect(session.lastActivityAt).toBeGreaterThanOrEqual(originalActivity);
      expect(session.requestCount).toBe(2);
    });

    test('touchSession is no-op for unknown session', () => {
      // Should not throw
      manager.touchSession('nonexistent');
    });

    test('removeSession removes an existing session', () => {
      manager.getOrCreateSession('sess-1');
      expect(manager.removeSession('sess-1')).toBe(true);
      expect(manager.getSession('sess-1')).toBeUndefined();
    });

    test('removeSession returns false for unknown session', () => {
      expect(manager.removeSession('nonexistent')).toBe(false);
    });

    test('isSessionValid returns true for fresh session', () => {
      manager.getOrCreateSession('sess-1');
      expect(manager.isSessionValid('sess-1')).toBe(true);
    });

    test('isSessionValid returns false for unknown session', () => {
      expect(manager.isSessionValid('nonexistent')).toBe(false);
    });

    test('LRU eviction when capacity reached', () => {
      const evicted: string[] = [];
      manager.on('session-evicted', ({ session }) => {
        evicted.push(session.sessionId);
      });

      manager.getOrCreateSession('sess-1');
      manager.getOrCreateSession('sess-2');
      manager.getOrCreateSession('sess-3');
      // This should evict sess-1 (LRU)
      manager.getOrCreateSession('sess-4');

      expect(evicted).toContain('sess-1');
      expect(manager.getSession('sess-1')).toBeUndefined();
      expect(manager.getSession('sess-4')).toBeDefined();
    });

    test('getStats returns correct statistics', () => {
      manager.getOrCreateSession('sess-1');
      manager.getOrCreateSession('sess-2');
      manager.getOrCreateSession('sess-1'); // access again

      const stats = manager.getStats();
      expect(stats.activeSessions).toBe(2);
      expect(stats.maxSessions).toBe(3);
      expect(stats.totalRequests).toBe(3); // 1 + 1 + 1 (re-access)
    });

    test('stop clears all sessions', () => {
      manager.getOrCreateSession('sess-1');
      manager.getOrCreateSession('sess-2');
      manager.stop();
      expect(manager.getAllSessions()).toHaveLength(0);
    });
  });

  describe('aliases', () => {
    test('createAlias and resolveAlias round-trip', () => {
      manager.createAlias('old-id', 'new-id');
      expect(manager.resolveAlias('old-id')).toBe('new-id');
    });

    test('resolveAlias returns undefined for unknown alias', () => {
      expect(manager.resolveAlias('nonexistent')).toBeUndefined();
    });

    test('alias expires after TTL', async () => {
      manager.createAlias('old-id', 'new-id', 50); // 50ms TTL
      expect(manager.resolveAlias('old-id')).toBe('new-id');

      await new Promise(resolve => setTimeout(resolve, 60));
      expect(manager.resolveAlias('old-id')).toBeUndefined();
    });

    test('getAliasCount returns count of active aliases', () => {
      manager.createAlias('old-1', 'new-1');
      manager.createAlias('old-2', 'new-2');
      expect(manager.getAliasCount()).toBe(2);
    });

    test('getAliasCount excludes expired aliases', async () => {
      manager.createAlias('old-1', 'new-1', 50);
      manager.createAlias('old-2', 'new-2', 5000);
      expect(manager.getAliasCount()).toBe(2);

      await new Promise(resolve => setTimeout(resolve, 60));
      expect(manager.getAliasCount()).toBe(1);
    });

    test('stop clears aliases', () => {
      manager.createAlias('old-1', 'new-1');
      manager.stop();
      expect(manager.resolveAlias('old-1')).toBeUndefined();
      expect(manager.getAliasCount()).toBe(0);
    });

    test('overwriting an alias updates the target', () => {
      manager.createAlias('old-id', 'new-1');
      manager.createAlias('old-id', 'new-2');
      expect(manager.resolveAlias('old-id')).toBe('new-2');
    });
  });
});
