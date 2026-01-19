import { EventEmitter } from 'events';
import { Debug } from './debug';
import { WorkerManager } from './worker-manager';

export interface PooledRequest {
  id: string;
  sessionId?: string;
  method: string;
  params: unknown;
  timestamp: number;
}

export interface PooledResponse {
  id: string;
  result?: unknown;
  error?: unknown;
}

export interface ConnectionPoolOptions {
  maxConnections: number;
  maxQueueSize: number;
  requestTimeout: number;
  sessionTimeout: number;
  sessionCheckInterval: number;
  workerScript?: string;
}

/**
 * Connection pool manager for handling concurrent MCP requests
 * Uses worker threads for true parallel processing
 */
export class ConnectionPool extends EventEmitter {
  protected activeConnections: Map<string, PooledRequest> = new Map();
  protected requestQueue: PooledRequest[] = [];
  protected workerManager?: WorkerManager;
  protected options: ConnectionPoolOptions;
  protected isShuttingDown: boolean = false;

  constructor(options: Partial<ConnectionPoolOptions> = {}) {
    super();
    this.options = {
      maxConnections: options.maxConnections || 32,
      maxQueueSize: options.maxQueueSize || 100,
      requestTimeout: options.requestTimeout || 30000, // 30 seconds
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
      sessionCheckInterval: options.sessionCheckInterval || 60000, // 1 minute
      workerScript: options.workerScript
    };
  }

  /**
   * Initialize the connection pool
   */
  async initialize(): Promise<void> {
    Debug.log(`🏊 Initializing connection pool with ${this.options.maxConnections} max connections`);
    
    // Initialize worker manager
    this.workerManager = new WorkerManager(this.options.workerScript);
    
    // Listen for worker events
    this.workerManager.on('worker-ready', (sessionId) => {
      Debug.log(`🎉 Worker ready for session ${sessionId}`);
    });
    
    this.workerManager.on('worker-error', ({ sessionId, error }) => {
      Debug.error(`💥 Worker error for session ${sessionId}:`, error);
    });
  }

  /**
   * Submit a request to the pool
   */
  async submitRequest(request: PooledRequest): Promise<PooledResponse> {
    if (this.isShuttingDown) {
      throw new Error('Connection pool is shutting down');
    }

    // Check if we're at capacity
    if (this.requestQueue.length >= this.options.maxQueueSize) {
      throw new Error('Request queue is full');
    }

    // Add to queue
    this.requestQueue.push(request);
    Debug.log(`📥 Request ${request.id} added to queue. Queue size: ${this.requestQueue.length}`);

    // Process queue
    this.processQueue();

    // Return a promise that resolves when the request is complete
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeRequest(request.id);
        reject(new Error(`Request ${request.id} timed out`));
      }, this.options.requestTimeout);

      this.once(`response:${request.id}`, (response: PooledResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          if (response.error instanceof Error) {
            reject(response.error);
          } else if (typeof response.error === 'string') {
            reject(new Error(response.error));
          } else if (response.error && typeof response.error === 'object' && 'message' in response.error) {
            reject(new Error(String((response.error as { message: unknown }).message)));
          } else {
            reject(new Error(JSON.stringify(response.error)));
          }
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Process queued requests using worker threads
   */
  protected processQueue(): void {
    while (
      this.requestQueue.length > 0 && 
      this.activeConnections.size < this.options.maxConnections
    ) {
      const request = this.requestQueue.shift();
      if (!request) continue;

      this.activeConnections.set(request.id, request);
      Debug.log(`🔄 Processing request ${request.id}. Active: ${this.activeConnections.size}/${this.options.maxConnections}`);

      // Check if this operation should use a worker
      if (this.shouldUseWorker(request)) {
        void this.processWithWorker(request);
      } else {
        // Process on main thread
        this.emit('process', request);
      }
    }
  }

  /**
   * Check if this request should use a worker
   */
  private shouldUseWorker(request: PooledRequest): boolean {
    if (!this.workerManager || !request.sessionId) {
      return false;
    }
    
    // List of CPU-intensive operations that benefit from workers
    const workerOps = [
      'tool.vault.search',
      'tool.vault.fragments', 
      'tool.graph.search-traverse',
      'tool.graph.advanced-traverse'
    ];
    
    return workerOps.some(op => request.method.includes(op));
  }
  
  /**
   * Process request with worker thread
   */
  private async processWithWorker(request: PooledRequest): Promise<void> {
    if (!this.workerManager || !request.sessionId) {
      // Fallback to main thread
      this.emit('process', request);
      return;
    }
    
    try {
      Debug.log(`🚀 Processing ${request.method} with worker for session ${request.sessionId}`);
      
      // Extract operation details from method
      const [, , operation] = request.method.split('.');
      
      const result = await this.workerManager.submitTask({
        id: request.id,
        sessionId: request.sessionId,
        operation,
        data: request.params
      });
      
      // Complete the request
      this.completeRequest(request.id, {
        id: request.id,
        result: result.result
      });
    } catch (error) {
      Debug.error(`❌ Worker processing failed for ${request.id}:`, error);
      
      // Fallback to main thread
      this.emit('process', request);
    }
  }

  /**
   * Mark a request as complete
   */
  completeRequest(requestId: string, response: PooledResponse): void {
    const request = this.activeConnections.get(requestId);
    if (!request) {
      Debug.warn(`⚠️ Attempt to complete unknown request: ${requestId}`);
      return;
    }

    this.activeConnections.delete(requestId);
    Debug.log(`✅ Request ${requestId} completed. Active: ${this.activeConnections.size}/${this.options.maxConnections}`);

    // Emit response event
    this.emit(`response:${requestId}`, response);

    // Process next request in queue
    this.processQueue();
  }

  /**
   * Remove a request from tracking
   */
  private removeRequest(requestId: string): void {
    this.activeConnections.delete(requestId);
    const queueIndex = this.requestQueue.findIndex(r => r.id === requestId);
    if (queueIndex !== -1) {
      this.requestQueue.splice(queueIndex, 1);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    activeConnections: number;
    queuedRequests: number;
    maxConnections: number;
    utilization: number;
  } {
    const active = this.activeConnections.size;
    return {
      activeConnections: active,
      queuedRequests: this.requestQueue.length,
      maxConnections: this.options.maxConnections,
      utilization: active / this.options.maxConnections
    };
  }

  /**
   * Shutdown the pool
   */
  async shutdown(): Promise<void> {
    Debug.log('🛑 Shutting down connection pool');
    this.isShuttingDown = true;

    // Clear the queue
    this.requestQueue = [];

    // Wait for active connections to complete (with timeout)
    const shutdownTimeout = 5000; // 5 seconds
    const startTime = Date.now();

    while (this.activeConnections.size > 0 && Date.now() - startTime < shutdownTimeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.activeConnections.size > 0) {
      Debug.warn(`⚠️ Force closing ${this.activeConnections.size} active connections`);
      this.activeConnections.clear();
    }

    // Terminate all workers
    if (this.workerManager) {
      await this.workerManager.terminateAll();
    }

    Debug.log('👋 Connection pool shutdown complete');
  }
}

/**
 * Request prioritization for the queue
 */
export enum RequestPriority {
  HIGH = 0,
  NORMAL = 1,
  LOW = 2
}

/**
 * Enhanced pooled request with priority
 */
export interface PrioritizedRequest extends PooledRequest {
  priority: RequestPriority;
}

/**
 * Priority-aware connection pool
 */
export class PriorityConnectionPool extends ConnectionPool {
  private priorityQueue: Map<RequestPriority, PooledRequest[]> = new Map([
    [RequestPriority.HIGH, []],
    [RequestPriority.NORMAL, []],
    [RequestPriority.LOW, []]
  ]);

  /**
   * Submit a request with priority
   */
  async submitPriorityRequest(request: PrioritizedRequest): Promise<PooledResponse> {
    const queue = this.priorityQueue.get(request.priority) || [];
    queue.push(request);
    
    // Override processQueue to handle priorities
    this.processQueue();
    
    return super.submitRequest(request);
  }

  /**
   * Process queue with priority ordering
   */
  protected processQueue(): void {
    // Process high priority first, then normal, then low
    for (const priority of [RequestPriority.HIGH, RequestPriority.NORMAL, RequestPriority.LOW]) {
      const queue = this.priorityQueue.get(priority) || [];
      
      while (
        queue.length > 0 && 
        this.activeConnections.size < this.options.maxConnections
      ) {
        const request = queue.shift();
        if (!request) continue;

        this.activeConnections.set(request.id, request);
        this.emit('process', request);
      }
    }
  }
}