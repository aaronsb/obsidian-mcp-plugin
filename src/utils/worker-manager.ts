import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { Debug } from './debug';
import * as path from 'path';

export interface WorkerTask {
  id: string;
  sessionId: string;
  operation: string;
  data: unknown;
}

export interface WorkerResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface WorkerMessage {
  type: string;
  id?: string;
  result?: unknown;
  error?: string;
}

/**
 * Manages worker threads for the connection pool
 * Each session gets its own worker thread for isolation
 */
export class WorkerManager extends EventEmitter {
  private workers: Map<string, Worker> = new Map();
  private pendingTasks: Map<string, (result: WorkerResult) => void> = new Map();
  private workerScript: string;
  
  constructor(workerScript?: string) {
    super();
    // Default to the compiled worker script
    this.workerScript = workerScript || path.join(__dirname, '..', 'workers', 'semantic-worker.js');
  }
  
  /**
   * Get or create a worker for a session
   */
  getWorker(sessionId: string): Worker {
    let worker = this.workers.get(sessionId);
    
    if (!worker) {
      Debug.log(`🏗️ Creating worker for session ${sessionId}`);
      worker = new Worker(this.workerScript);
      
      // Set up message handling
      worker.on('message', (message: unknown) => {
        this.handleWorkerMessage(sessionId, message as WorkerMessage);
      });
      
      worker.on('error', (error: Error) => {
        Debug.error(`❌ Worker error for session ${sessionId}:`, error);
        this.handleWorkerError(sessionId, error);
      });
      
      worker.on('exit', (code) => {
        Debug.log(`👋 Worker for session ${sessionId} exited with code ${code}`);
        this.workers.delete(sessionId);
      });
      
      this.workers.set(sessionId, worker);
    }
    
    return worker;
  }
  
  /**
   * Submit a task to a worker
   */
  async submitTask(task: WorkerTask): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = this.getWorker(task.sessionId);
      
      // Store the callback
      this.pendingTasks.set(task.id, (result) => {
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || 'Unknown worker error'));
        }
      });
      
      // Send task to worker
      const taskData = task.data as Record<string, unknown> | undefined;
      worker.postMessage({
        id: task.id,
        type: 'process',
        request: {
          operation: task.operation,
          action: taskData?.action,
          params: task.data
        }
      });
      
      // Set timeout
      setTimeout(() => {
        if (this.pendingTasks.has(task.id)) {
          this.pendingTasks.delete(task.id);
          reject(new Error('Worker task timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }
  
  /**
   * Handle message from worker
   */
  private handleWorkerMessage(sessionId: string, message: WorkerMessage): void {
    if (message.type === 'ready') {
      Debug.log(`✅ Worker for session ${sessionId} is ready`);
      this.emit('worker-ready', sessionId);
      return;
    }

    if (message.id && this.pendingTasks.has(message.id)) {
      const callback = this.pendingTasks.get(message.id)!;
      this.pendingTasks.delete(message.id);

      const result: WorkerResult = {
        id: message.id,
        success: message.type === 'result',
        result: message.result,
        error: message.error
      };

      callback(result);
    }
  }
  
  /**
   * Handle worker error
   */
  private handleWorkerError(sessionId: string, error: Error): void {
    // Fail all pending tasks for this worker
    for (const [taskId, callback] of this.pendingTasks.entries()) {
      callback({
        id: taskId,
        success: false,
        error: `Worker error: ${error.message}`
      });
    }
    
    // Clean up
    this.workers.delete(sessionId);
    this.emit('worker-error', { sessionId, error });
  }
  
  /**
   * Terminate a worker
   */
  async terminateWorker(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (worker) {
      Debug.log(`🛑 Terminating worker for session ${sessionId}`);
      await worker.terminate();
      this.workers.delete(sessionId);
    }
  }
  
  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    Debug.log(`🛑 Terminating all ${this.workers.size} workers`);
    const promises = [];
    
    for (const [, worker] of this.workers) {
      promises.push(worker.terminate());
    }
    
    await Promise.all(promises);
    this.workers.clear();
    this.pendingTasks.clear();
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      activeWorkers: this.workers.size,
      pendingTasks: this.pendingTasks.size,
      workerSessions: Array.from(this.workers.keys())
    };
  }
}