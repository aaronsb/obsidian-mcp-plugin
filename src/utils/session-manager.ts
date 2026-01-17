import { EventEmitter } from 'events';
import { Debug } from './debug';

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  requestCount: number;
  metadata?: unknown;
}

export interface SessionManagerOptions {
  maxSessions: number;
  sessionTimeout: number; // in milliseconds
  checkInterval: number; // how often to check for expired sessions
}

/**
 * Manages MCP session lifecycle with automatic timeout and recycling
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private sessionOrder: string[] = []; // Track session order for LRU eviction
  private options: SessionManagerOptions;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(options: Partial<SessionManagerOptions> = {}) {
    super();
    this.options = {
      maxSessions: options.maxSessions || 32,
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour default
      checkInterval: options.checkInterval || 60000 // Check every minute
    };
  }

  /**
   * Start the session manager
   */
  start(): void {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.options.checkInterval);

    Debug.log(`🔐 Session manager started with ${this.options.maxSessions} max sessions, ${this.options.sessionTimeout}ms timeout`);
  }

  /**
   * Stop the session manager
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.sessions.clear();
    this.sessionOrder = [];
    Debug.log('🔐 Session manager stopped');
  }

  /**
   * Create or retrieve a session
   */
  getOrCreateSession(sessionId: string): SessionInfo {
    const now = Date.now();
    
    // Check if session exists
    let session = this.sessions.get(sessionId);
    
    if (session) {
      // Update last activity
      session.lastActivityAt = now;
      session.requestCount++;
      
      // Move to end of order (most recently used)
      const index = this.sessionOrder.indexOf(sessionId);
      if (index > -1) {
        this.sessionOrder.splice(index, 1);
      }
      this.sessionOrder.push(sessionId);
      
      Debug.log(`📍 Session ${sessionId} accessed (request #${session.requestCount})`);
      return session;
    }

    // Check if we need to evict a session
    if (this.sessions.size >= this.options.maxSessions) {
      // Find the least recently used session
      const lruSessionId = this.findLRUSession();
      
      if (lruSessionId) {
        this.evictSession(lruSessionId, 'capacity');
      }
    }

    // Create new session
    session = {
      sessionId,
      createdAt: now,
      lastActivityAt: now,
      requestCount: 1
    };

    this.sessions.set(sessionId, session);
    this.sessionOrder.push(sessionId);
    
    Debug.log(`🆕 New session created: ${sessionId} (Total: ${this.sessions.size}/${this.options.maxSessions})`);
    this.emit('session-created', session);
    
    return session;
  }

  /**
   * Update session activity
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
      session.requestCount++;
      
      // Move to end of order
      const index = this.sessionOrder.indexOf(sessionId);
      if (index > -1) {
        this.sessionOrder.splice(index, 1);
        this.sessionOrder.push(sessionId);
      }
    }
  }

  /**
   * Remove a session
   */
  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.sessions.delete(sessionId);
    const index = this.sessionOrder.indexOf(sessionId);
    if (index > -1) {
      this.sessionOrder.splice(index, 1);
    }

    Debug.log(`🗑️ Session removed: ${sessionId} (Remaining: ${this.sessions.size})`);
    this.emit('session-removed', session);
    
    return true;
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session statistics
   */
  getStats(): {
    activeSessions: number;
    maxSessions: number;
    oldestSessionAge: number;
    newestSessionAge: number;
    totalRequests: number;
  } {
    const now = Date.now();
    const sessions = Array.from(this.sessions.values());
    
    let oldestAge = 0;
    let newestAge = Infinity;
    let totalRequests = 0;

    for (const session of sessions) {
      const age = now - session.createdAt;
      oldestAge = Math.max(oldestAge, age);
      newestAge = Math.min(newestAge, age);
      totalRequests += session.requestCount;
    }

    return {
      activeSessions: this.sessions.size,
      maxSessions: this.options.maxSessions,
      oldestSessionAge: sessions.length > 0 ? oldestAge : 0,
      newestSessionAge: sessions.length > 0 ? newestAge : 0,
      totalRequests
    };
  }

  /**
   * Find the least recently used session
   */
  private findLRUSession(): string | undefined {
    // Sessions are ordered by last use, so first one is LRU
    if (this.sessionOrder.length > 0) {
      return this.sessionOrder[0];
    }

    // Fallback: find session with oldest activity
    let lruSessionId: string | undefined;
    let oldestActivity = Date.now();

    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt < oldestActivity) {
        oldestActivity = session.lastActivityAt;
        lruSessionId = sessionId;
      }
    }

    return lruSessionId;
  }

  /**
   * Evict a session
   */
  private evictSession(sessionId: string, reason: 'timeout' | 'capacity'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const age = Date.now() - session.createdAt;
    const idleTime = Date.now() - session.lastActivityAt;

    Debug.log(`♻️ Evicting session ${sessionId} (reason: ${reason}, age: ${Math.round(age / 1000)}s, idle: ${Math.round(idleTime / 1000)}s)`);
    
    this.emit('session-evicted', { session, reason });
    this.removeSession(sessionId);
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const idleTime = now - session.lastActivityAt;
      
      if (idleTime > this.options.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }

    if (expiredSessions.length > 0) {
      Debug.log(`🧹 Cleaning up ${expiredSessions.length} expired sessions`);
      
      for (const sessionId of expiredSessions) {
        this.evictSession(sessionId, 'timeout');
      }
    }
  }

  /**
   * Check if a session is valid (exists and not expired)
   */
  isSessionValid(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const idleTime = Date.now() - session.lastActivityAt;
    return idleTime <= this.options.sessionTimeout;
  }
}