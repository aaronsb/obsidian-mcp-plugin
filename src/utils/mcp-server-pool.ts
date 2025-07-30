import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { EventEmitter } from 'events';
import { Debug } from './debug';
import { ObsidianAPI } from './obsidian-api';
import { SecureObsidianAPI } from '../security/secure-obsidian-api';
import { semanticTools, createSemanticTools } from '../tools/semantic-tools';
import { DataviewTool, isDataviewToolAvailable } from '../tools/dataview-tool';
import { getVersion } from '../version';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';

interface PooledServer {
  server: MCPServer;
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
  getOrCreateServer(sessionId: string): MCPServer {
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
  private createNewServer(sessionId: string): MCPServer {
    const server = new MCPServer(
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

    // Register tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const availableTools = createSemanticTools(this.obsidianAPI);
      return {
        tools: availableTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      };
    });

    // Handle tool calls with session-specific API
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      
      const availableTools = createSemanticTools(this.obsidianAPI);
      const tool = availableTools.find(t => t.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }
      
      Debug.log(`🔧 [Session ${sessionId}] Executing tool: ${name} with action: ${args?.action}`);
      
      // Execute tool with session-specific API
      return await tool.handler(sessionAPI, args);
    });

    // Handle resource listing
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [
        {
          uri: 'obsidian://vault-info',
          name: 'Vault Information',
          description: 'Current vault status, file counts, and metadata',
          mimeType: 'application/json'
        }
      ];
      
      if (this.plugin?.settings?.enableConcurrentSessions) {
        resources.push({
          uri: 'obsidian://session-info',
          name: 'Session Information',
          description: 'Active MCP sessions and connection pool statistics',
          mimeType: 'application/json'
        });
      }

      // Add Dataview reference resource if plugin is available
      if (isDataviewToolAvailable(this.obsidianAPI)) {
        resources.push({
          uri: 'obsidian://dataview-reference',
          name: 'Dataview Query Language Reference',
          description: 'Complete DQL syntax guide with examples, functions, and best practices',
          mimeType: 'text/markdown'
        });
      }
      
      return { resources };
    });

    // Handle resource reading
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      
      if (uri === 'obsidian://vault-info') {
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
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(vaultInfo, null, 2)
          }]
        };
      }
      
      if (uri === 'obsidian://session-info' && this.sessionManager) {
        // Get all sessions
        const sessions = this.sessionManager.getAllSessions();
        const sessionStats = this.sessionManager.getStats();
        const poolStats = this.connectionPool?.getStats();
        const serverPoolStats = this.getStats();
        
        // Format session data
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
        
        // Sort sessions - current session first, then by last activity
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
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sessionInfo, null, 2)
          }]
        };
      }

      if (uri === 'obsidian://dataview-reference') {
        if (!isDataviewToolAvailable(this.obsidianAPI)) {
          throw new Error('Dataview plugin is not available');
        }

        return {
          contents: [{
            uri,
            mimeType: 'text/markdown',
            text: DataviewTool.generateDataviewReference()
          }]
        };
      }
      
      throw new Error(`Resource not found: ${uri}`);
    });

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