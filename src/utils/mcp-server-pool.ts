import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { EventEmitter } from 'events';
import { Debug } from './debug';
import { ObsidianAPI } from './obsidian-api';
import { SecureObsidianAPI } from '../security/secure-obsidian-api';
import { createSemanticTools } from '../tools/semantic-tools';
import { DataviewTool, isDataviewToolAvailable } from '../tools/dataview-tool';
import { getVersion } from '../version';
import type { SessionManager } from './session-manager';
import type { ConnectionPool } from './connection-pool';

/** Plugin interface with settings relevant to MCPServerPool.
 * Includes fields from SecurePluginRef and ObsidianAPIPluginRef so the same object
 * can be passed through the constructor chain. */
interface PluginWithSettings {
  settings?: {
    readOnlyMode?: boolean;
    enableWebFetch?: boolean;
    // From SecurePluginRef (for SecureObsidianAPI)
    security?: Partial<import('../security/vault-security-manager').SecuritySettings>;
    // From ObsidianAPIPluginRef (for ObsidianAPI)
    validation?: Partial<import('../validation/input-validator').ValidationConfig>;
    httpPort?: number;
    toolVisibility?: Record<string, boolean>;
  };
  ignoreManager?: import('../security/mcp-ignore-manager').MCPIgnoreManager;
  mcpServer?: { isServerRunning(): boolean; getConnectionCount(): number };
  manifest?: { dir?: string };
}

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
  private plugin?: PluginWithSettings;
  private sessionManager?: SessionManager;
  private connectionPool?: ConnectionPool;
  // ADR-107: agent-visible warning string injected into MCP initialize.instructions
  // when the network exposure verdict is 'jail'. Null otherwise (no field sent).
  private initializeInstructions: string | null = null;

  constructor(obsidianAPI: ObsidianAPI | SecureObsidianAPI, maxServers: number = 32, plugin?: PluginWithSettings) {
    super();
    this.obsidianAPI = obsidianAPI;
    this.maxServers = maxServers;
    this.plugin = plugin;
  }

  /**
   * Set session manager and connection pool references
   */
  setContexts(sessionManager: SessionManager, connectionPool: ConnectionPool) {
    this.sessionManager = sessionManager;
    this.connectionPool = connectionPool;
  }

  /**
   * ADR-107: set the instructions string returned on MCP initialize.
   * Called from MCPHttpServer.start() after the verdict is classified.
   * Pass null to clear (no instructions field on initialize result).
   */
  setInitializeInstructions(instructions: string | null) {
    this.initializeInstructions = instructions;
  }

  /**
   * Build the currently-visible tool set from live plugin settings.
   *
   * Called per request rather than once per session so a settings toggle
   * applies to sessions that already exist. `enableWebFetch` is passed
   * explicitly as a boolean — `createSemanticTools` fails closed on an omitted
   * flag, and this keeps the intent visible at the call site (ADR-109).
   */
  private buildTools() {
    return createSemanticTools(
      this.obsidianAPI,
      this.plugin?.settings?.toolVisibility,
      this.plugin?.settings?.enableWebFetch === true
    );
  }

  /**
   * Tell every live session its tool list changed, so clients re-fetch instead
   * of holding the list they cached at connection time (#285).
   *
   * Best-effort by design: the SDK no-ops on a server with no connected
   * transport, and one session's failure must not stop the rest — a settings
   * toggle is a UI action, not a transaction.
   */
  notifyToolListChanged(): void {
    let notified = 0;
    for (const [sessionId, pooled] of this.servers) {
      try {
        pooled.server.sendToolListChanged();
        notified++;
      } catch (error: unknown) {
        Debug.error(`[Session ${sessionId}] tools/list_changed notify failed:`, error);
      }
    }
    Debug.log(`📢 Notified ${notified}/${this.servers.size} session(s) of a tool list change`);
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
      // Construct via McpServer (the non-deprecated class) and register our
      // raw JSON-Schema handlers on its underlying .server — the advanced
      // low-level handle it deliberately exposes — so the deprecated Server
      // symbol never appears in our source. We don't use registerTool/Zod.
      const mcpServer = new McpServer(
      {
        name: 'Semantic Notes Vault MCP',
        version: getVersion()
      },
      {
        capabilities: {
          // listChanged advertises that this server pushes
          // notifications/tools/list_changed when the visible tool set changes
          // (settings toggles). Without the declaration a spec-compliant client
          // is entitled to ignore the notification.
          tools: { listChanged: true },
          resources: {}
        },
        // ADR-107: agent-visible network-exposure warning, only set when 🔴
        ...(this.initializeInstructions ? { instructions: this.initializeInstructions } : {})
      }
    );
    const server = mcpServer.server;

    // Create session-specific API instance
    // Always create SecureObsidianAPI if the main API has security settings
    let sessionAPI: ObsidianAPI | SecureObsidianAPI;
    if (this.obsidianAPI instanceof SecureObsidianAPI) {
      // Without a plugin reference the session API has no settings to read, so
      // read-only cannot be enforced on it — while path validation still can,
      // which is the worst combination: a boundary that looks whole and isn't.
      // Verified behaviour when absent: edit.append writes while a user believing
      // read-only is on sees nothing. Same wiring-bug class as the missing
      // security layer below, so it fails the same way rather than only logging.
      if (!this.plugin) {
        throw new Error(
          'Refusing to create a session without a plugin reference: read-only mode ' +
          'could not be enforced on it. This is a wiring bug, not a runtime condition.'
        );
      }

      // Main API is SecureObsidianAPI - create matching secure instance
      sessionAPI = new SecureObsidianAPI(
        this.obsidianAPI.getApp(),
        undefined,
        this.plugin,
        this.obsidianAPI.getSecuritySettings()
      );
      Debug.log(`🔐 Created secure session API for session ${sessionId}`);
    } else {
      // Previously this fell back to a plain ObsidianAPI and logged "(no
      // security)" — a session with NOTHING between it and vault writes: no
      // read-only, no path validation, no .mcpignore. Unreachable today because
      // mcp-server.ts always builds a SecureObsidianAPI, but a silent fail-open
      // is exactly the shape of the bugs this enforcement work exists to close,
      // so it fails loudly instead of quietly serving an unguarded session.
      throw new Error(
        'Refusing to create a session without the security layer: the parent API ' +
        'is not a SecureObsidianAPI. This is a wiring bug, not a runtime condition.'
      );
    }

    // List tools handler. The list is built per request, not captured here.
    //
    // It used to be a `const availableTools` closed over by both handlers, which
    // froze a session's tool surface at creation: toggling a tool off left every
    // live session advertising and dispatching it until the session was evicted
    // or the client reconnected. That is the stale-snapshot shape ADR-108
    // removed from permission state, in the sibling control — same fix here, and
    // the reason a `tools/list_changed` notification is worth sending at all
    // (a client that re-fetched a snapshot would just receive it again).
    server.setRequestHandler(ListToolsRequestSchema, () => {
      Debug.log(`📋 [Session ${sessionId}] Listing available tools`);
      return {
        tools: this.buildTools().map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      };
    });

    // Call tool handler
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      Debug.log(`🔧 [Session ${sessionId}] Executing tool: ${name}`, args);

      const tool = this.buildTools().find(t => t.name === name);
      if (!tool) {
        return {
          content: [{
            type: 'text',
            text: `Error: Unknown tool "${name}"`
          }],
          isError: true
        };
      }

      try {
        const result = await tool.handler(sessionAPI, args ?? {});
        return result as CallToolResult;
      } catch (error: unknown) {
        Debug.error(`[Session ${sessionId}] Tool execution error (${name}):`, error);
        return {
          content: [{
            type: 'text',
            text: `Error executing tool "${name}": ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    });

    // Build resources list
    const resources = [
      {
        uri: 'obsidian://vault-info',
        name: 'Vault Information',
        description: 'Current vault status, file counts, and metadata',
        mimeType: 'application/json'
      }
    ];

    // Add session-info resource
    if (this.sessionManager) {
      resources.push({
        uri: 'obsidian://session-info',
        name: 'Session Information',
        description: 'Active MCP sessions and connection pool statistics',
        mimeType: 'application/json'
      });
    }

    // Add Dataview reference if available
    if (isDataviewToolAvailable(this.obsidianAPI)) {
      resources.push({
        uri: 'obsidian://dataview-reference',
        name: 'Dataview Query Language Reference',
        description: 'Complete DQL syntax guide with examples, functions, and best practices',
        mimeType: 'text/markdown'
      });
    }

    // List resources handler
    server.setRequestHandler(ListResourcesRequestSchema, () => {
      Debug.log(`📋 [Session ${sessionId}] Listing available resources`);
      return { resources };
    });

    // Read resource handler
    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      const { uri } = request.params;
      Debug.log(`📖 [Session ${sessionId}] Reading resource: ${uri}`);

      if (uri === 'obsidian://vault-info') {
        const app = this.obsidianAPI.getApp();
        const vaultName = app.vault.getName();
        const activeFile = app.workspace.getActiveFile();
        const allFiles = app.vault.getAllLoadedFiles();
        const markdownFiles = app.vault.getMarkdownFiles();

        const vaultInfo = {
          vault: {
            name: vaultName,
            path: (app.vault.adapter as unknown as { basePath?: string }).basePath ?? 'Unknown'
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
      }

      if (uri === 'obsidian://session-info' && this.sessionManager) {
        const sessions = this.sessionManager.getAllSessions();
        const sessionStats = this.sessionManager.getStats();
        const poolStats = this.connectionPool?.getStats();
        const serverPoolStats = this.getStats();

        interface SessionDataItem {
          sessionId: string;
          isCurrentSession: boolean;
          createdAt: string;
          lastActivityAt: string;
          requestCount: number;
          ageSeconds: number;
          idleSeconds: number;
          status: string;
        }

        const sessionData: SessionDataItem[] = sessions.map((session) => {
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

        sessionData.sort((a: SessionDataItem, b: SessionDataItem) => {
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
            maxConcurrentConnections: this.maxServers
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
      }

      if (uri === 'obsidian://dataview-reference' && isDataviewToolAvailable(this.obsidianAPI)) {
        return {
          contents: [{
            uri: 'obsidian://dataview-reference',
            mimeType: 'text/markdown',
            text: DataviewTool.generateDataviewReference()
          }]
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    });

    return mcpServer;
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
  shutdown(): void {
    Debug.log(`🛑 Shutting down MCP server pool (${this.servers.size} servers)`);
    this.servers.clear();
  }
}