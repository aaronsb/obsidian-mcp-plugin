import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EventEmitter } from 'events';
import { Debug } from './debug';
import { ObsidianAPI } from './obsidian-api';
import { SecureObsidianAPI } from '../security/secure-obsidian-api';
import { createSemanticTools } from '../tools/semantic-tools';
import { DataviewTool, isDataviewToolAvailable } from '../tools/dataview-tool';
import { getVersion } from '../version';
import { jsonSchemaToZod } from './json-schema-to-zod';

interface PooledServer {
  server: McpServer;
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  requestCount: number;
}

export class MCPServerPool extends EventEmitter {
  private servers: Map<string, PooledServer> = new Map();
  private maxServers: number;
  private obsidianAPI: ObsidianAPI | SecureObsidianAPI;
  private plugin: any;
  private sessionManager?: any;
  private connectionPool?: any;

  constructor(obsidianAPI: ObsidianAPI | SecureObsidianAPI, maxServers: number = 32, plugin?: any) {
    super();
    this.obsidianAPI = obsidianAPI;
    this.maxServers = maxServers;
    this.plugin = plugin;
  }

  /**
   * Set session manager and connection pool references
   */
  setContexts(sessionManager: any, connectionPool: any) {
    this.sessionManager = sessionManager;
    this.connectionPool = connectionPool;
  }

  /**
   * Get or create an MCP server for a session
   */
  getOrCreateServer(sessionId: string): McpServer {
    // Check if server exists
    let pooledServer = this.servers.get(sessionId);
    
    if (pooledServer) {
      // Update activity
      pooledServer.lastActivityAt = Date.now();
      pooledServer.requestCount++;
      Debug.log(`♻️ Reusing MCP server for session ${sessionId}`);
      return pooledServer.server;
    }

    // Check capacity
    if (this.servers.size >= this.maxServers) {
      // Evict oldest inactive server
      this.evictOldestServer();
    }

    // Create new server
    const server = this.createNewServer(sessionId);
    
    pooledServer = {
      server,
      sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      requestCount: 1
    };
    
    this.servers.set(sessionId, pooledServer);
    Debug.log(`🆕 Created new MCP server for session ${sessionId} (Total: ${this.servers.size}/${this.maxServers})`);
    
    return server;
  }

  /**
   * Create a new MCP server instance with handlers
   */
  private createNewServer(sessionId: string): McpServer {
    const server = new McpServer(
      {
        name: 'Semantic Notes Vault MCP',
        version: getVersion()
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        }
      }
    );

    // Create session-specific API instance
    // Always create SecureObsidianAPI if the main API has security settings
    let sessionAPI: ObsidianAPI | SecureObsidianAPI;
    if ('getSecuritySettings' in this.obsidianAPI) {
      // Main API is SecureObsidianAPI - create matching secure instance
      sessionAPI = new SecureObsidianAPI(
        this.obsidianAPI.getApp(), 
        undefined, 
        this.plugin,
        (this.obsidianAPI as any).getSecuritySettings()
      );
      Debug.log(`🔐 Created secure session API for session ${sessionId}`);
    } else {
      // Fallback to regular ObsidianAPI
      sessionAPI = new ObsidianAPI(this.obsidianAPI.getApp(), undefined, this.plugin);
      Debug.log(`⚠️ Created regular session API for session ${sessionId} (no security)`);
    }

    // Register semantic tools using the new McpServer API
    const availableTools = createSemanticTools(this.obsidianAPI);
    for (const tool of availableTools) {
      // Convert JSON Schema to Zod schema for the new McpServer API
      const zodSchema = jsonSchemaToZod(tool.inputSchema as {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      });

      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: zodSchema
      }, async (args: unknown) => {
        const typedArgs = args as Record<string, unknown>;
        const action = typedArgs && typeof typedArgs === 'object' && 'action' in typedArgs ? String(typedArgs.action) : 'unknown';
        Debug.log(`🔧 [Session ${sessionId}] Executing tool: ${tool.name} with action: ${action}`);
        return await tool.handler(sessionAPI, typedArgs);
      });
    }

    // Register vault-info resource
    server.registerResource('Vault Information', 'obsidian://vault-info', {
      description: 'Current vault status, file counts, and metadata',
      mimeType: 'application/json'
    }, async () => {
      const app = this.obsidianAPI.getApp();
      const vaultName = app.vault.getName();
      const activeFile = app.workspace.getActiveFile();
      const allFiles = app.vault.getAllLoadedFiles();
      const markdownFiles = app.vault.getMarkdownFiles();

      const vaultInfo = {
        vault: {
          name: vaultName,
          path: (app.vault.adapter as any).basePath || 'Unknown'
        },
        activeFile: activeFile ? {
          name: activeFile.name,
          path: activeFile.path,
          basename: activeFile.basename,
          extension: activeFile.extension
        } : null,
        files: {
          total: allFiles.length,
          markdown: markdownFiles.length,
          attachments: allFiles.length - markdownFiles.length
        },
        plugin: {
          version: getVersion(),
          status: 'Connected and operational',
          transport: 'HTTP MCP via Express.js + MCP SDK',
          sessionId: sessionId
        },
        timestamp: new Date().toISOString()
      };

      return {
        contents: [{
          uri: 'obsidian://vault-info',
          mimeType: 'application/json',
          text: JSON.stringify(vaultInfo, null, 2)
        }]
      };
    });

    // Register session-info resource if concurrent sessions enabled
    if (this.plugin?.settings?.enableConcurrentSessions && this.sessionManager) {
      server.registerResource('Session Information', 'obsidian://session-info', {
        description: 'Active MCP sessions and connection pool statistics',
        mimeType: 'application/json'
      }, async () => {
        const sessions = this.sessionManager!.getAllSessions();
        const sessionStats = this.sessionManager!.getStats();
        const poolStats = this.connectionPool?.getStats();
        const serverPoolStats = this.getStats();

        const sessionData = sessions.map((session: any) => {
          const idleTime = Date.now() - session.lastActivityAt;
          const age = Date.now() - session.createdAt;
          return {
            sessionId: session.sessionId,
            isCurrentSession: session.sessionId === sessionId,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivityAt: new Date(session.lastActivityAt).toISOString(),
            requestCount: session.requestCount,
            ageSeconds: Math.round(age / 1000),
            idleSeconds: Math.round(idleTime / 1000),
            status: session.sessionId === sessionId ? '🟢 This is you!' : '🔵 Active'
          };
        });

        sessionData.sort((a: any, b: any) => {
          if (a.isCurrentSession) return -1;
          if (b.isCurrentSession) return 1;
          return b.lastActivityAt.localeCompare(a.lastActivityAt);
        });

        const sessionInfo = {
          summary: {
            activeSessions: sessionStats.activeSessions,
            maxSessions: sessionStats.maxSessions,
            utilization: `${Math.round((sessionStats.activeSessions / sessionStats.maxSessions) * 100)}%`,
            totalRequests: sessionStats.totalRequests,
            oldestSessionAge: `${Math.round(sessionStats.oldestSessionAge / 1000)}s`,
            newestSessionAge: `${Math.round(sessionStats.newestSessionAge / 1000)}s`
          },
          serverPool: {
            activeServers: serverPoolStats.activeServers,
            maxServers: serverPoolStats.maxServers,
            utilization: serverPoolStats.utilization,
            totalRequests: serverPoolStats.totalRequests
          },
          connectionPool: poolStats ? {
            activeConnections: poolStats.activeConnections,
            queuedRequests: poolStats.queuedRequests,
            maxConnections: poolStats.maxConnections,
            poolUtilization: `${Math.round(poolStats.utilization * 100)}%`
          } : null,
          sessions: sessionData,
          settings: {
            sessionTimeout: '1 hour',
            maxConcurrentConnections: this.plugin?.settings?.maxConcurrentConnections || 32
          },
          timestamp: new Date().toISOString()
        };

        return {
          contents: [{
            uri: 'obsidian://session-info',
            mimeType: 'application/json',
            text: JSON.stringify(sessionInfo, null, 2)
          }]
        };
      });
    }

    // Register Dataview reference resource if plugin is available
    if (isDataviewToolAvailable(this.obsidianAPI)) {
      server.registerResource('Dataview Query Language Reference', 'obsidian://dataview-reference', {
        description: 'Complete DQL syntax guide with examples, functions, and best practices',
        mimeType: 'text/markdown'
      }, async () => {
        return {
          contents: [{
            uri: 'obsidian://dataview-reference',
            mimeType: 'text/markdown',
            text: DataviewTool.generateDataviewReference()
          }]
        };
      });
    }

    return server;
  }

  /**
   * Evict the oldest inactive server
   */
  private evictOldestServer(): void {
    let oldestSessionId: string | null = null;
    let oldestActivity = Date.now();

    for (const [sessionId, server] of this.servers) {
      if (server.lastActivityAt < oldestActivity) {
        oldestActivity = server.lastActivityAt;
        oldestSessionId = sessionId;
      }
    }

    if (oldestSessionId) {
      this.servers.delete(oldestSessionId);
      Debug.log(`🗑️ Evicted oldest MCP server: ${oldestSessionId}`);
      this.emit('server-evicted', { sessionId: oldestSessionId });
    }
  }

  /**
   * Get statistics about the server pool
   */
  getStats() {
    const servers = Array.from(this.servers.values());
    const now = Date.now();

    return {
      activeServers: this.servers.size,
      maxServers: this.maxServers,
      utilization: `${Math.round((this.servers.size / this.maxServers) * 100)}%`,
      totalRequests: servers.reduce((sum, s) => sum + s.requestCount, 0),
      oldestServerAge: servers.length > 0 
        ? Math.max(...servers.map(s => now - s.createdAt))
        : 0,
      newestServerAge: servers.length > 0
        ? Math.min(...servers.map(s => now - s.createdAt))
        : 0
    };
  }

  /**
   * Clean up all servers
   */
  async shutdown(): Promise<void> {
    Debug.log(`🛑 Shutting down MCP server pool (${this.servers.size} servers)`);
    this.servers.clear();
  }
}