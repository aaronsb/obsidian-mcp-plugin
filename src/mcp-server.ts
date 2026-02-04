import express from 'express';
import cors from 'cors';
import { App, FileSystemAdapter, Notice } from 'obsidian';
import { createServer as createHttpServer, Server, IncomingMessage, ServerResponse } from 'http';
import { Server as HttpsServer } from 'https';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { getVersion } from './version';
import { ObsidianAPI } from './utils/obsidian-api';
import { SecureObsidianAPI, VaultSecurityManager } from './security';
import { semanticTools, createSemanticTools } from './tools/semantic-tools';
import { DataviewTool, isDataviewToolAvailable } from './tools/dataview-tool';
import { Debug } from './utils/debug';
import { ConnectionPool, PooledRequest } from './utils/connection-pool';
import { SessionManager } from './utils/session-manager';
import { MCPServerPool } from './utils/mcp-server-pool';
import { CertificateManager, CertificateConfig } from './utils/certificate-manager';

/** Minimal plugin interface for MCPHttpServer.
 * Includes fields from SecurePluginRef and ObsidianAPIPluginRef so the same object
 * can be passed through the constructor chain. */
interface MCPPluginRef {
  settings?: {
    httpsEnabled?: boolean;
    httpsPort?: number;
    httpPort?: number;
    certificateConfig?: CertificateConfig;
    readOnlyMode?: boolean;
    enableConcurrentSessions?: boolean;
    maxConcurrentConnections?: number;
    apiKey?: string;
    dangerouslyDisableAuth?: boolean;
    // From SecurePluginRef (for SecureObsidianAPI)
    security?: Partial<import('./security/vault-security-manager').SecuritySettings>;
    // From ObsidianAPIPluginRef (for ObsidianAPI)
    validation?: Partial<import('./validation/input-validator').ValidationConfig>;
  };
  manifest: { dir?: string };
  // From ObsidianAPIPluginRef
  ignoreManager?: import('./security/mcp-ignore-manager').MCPIgnoreManager;
  mcpServer?: { isServerRunning(): boolean; getConnectionCount(): number };
}

/** JSON-RPC request body structure */
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Server with configurable timeout properties (Node.js http.Server internals) */
interface ServerWithTimeouts {
  keepAliveTimeout: number;
  headersTimeout: number;
  requestTimeout: number;
  setTimeout: (msecs: number) => unknown;
}

/** Vault adapter with basePath for file system access */
interface VaultAdapterWithBasePath extends FileSystemAdapter {
  basePath?: string;
}

/** Null response shim for internal initialize calls */
interface NullResponse {
  writeHead: (status: number, headers?: Record<string, string>) => void;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
  statusCode: number;
  headersSent: boolean;
  write: (chunk: unknown) => void;
  end: (data?: unknown) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  once: (event: string, handler: (...args: unknown[]) => void) => void;
  status: (v: number) => NullResponse;
  json: (body: unknown) => void;
  send: (body?: unknown) => void;
}

/** Connection pool stats response */
interface ConnectionPoolStatsResponse {
  enabled: boolean;
  stats?: {
    activeConnections: number;
    queuedRequests: number;
    maxConnections: number;
    utilization: number;
  };
  serverPoolStats?: {
    activeServers: number;
    maxServers: number;
    utilization: string;
    totalRequests: number;
  };
}


export class MCPHttpServer {
  private app: express.Application;
  private server?: Server | HttpsServer;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Using Server (not McpServer) because McpServer requires Zod schemas
  private mcpServer?: MCPServer; // Single server for non-concurrent mode
  private mcpServerPool?: MCPServerPool; // Server pool for concurrent mode
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private obsidianApp: App;
  private obsidianAPI: ObsidianAPI;
  private port: number;
  private isRunning: boolean = false;
  private connectionCount: number = 0;
  private plugin?: MCPPluginRef; // Reference to the plugin
  private connectionPool?: ConnectionPool;
  private sessionManager?: SessionManager;
  private certificateManager: CertificateManager | null;
  private isHttps: boolean = false;

  constructor(obsidianApp: App, port: number = 3001, plugin?: MCPPluginRef) {
    this.obsidianApp = obsidianApp;
    this.port = port;
    this.plugin = plugin;

    // Only initialize certificate manager if HTTPS is enabled
    // to avoid fs module issues in browser environment
    if (plugin?.settings?.httpsEnabled && plugin?.settings?.certificateConfig?.enabled) {
      this.isHttps = true;
      this.port = plugin.settings.httpsPort ?? 3443;
      // Lazy initialize certificate manager only when needed
      this.certificateManager = null; // Will be initialized when server starts
    } else {
      this.certificateManager = null;
    }
    
    // Always use SecureObsidianAPI with VaultSecurityManager as our firewall
    Debug.log('🔐 Initializing VaultSecurityManager firewall');
    
    // Configure security rules based on mode
    let securitySettings;
    if (plugin?.settings?.readOnlyMode) {
      Debug.log('🔒 READ-ONLY MODE ACTIVATED - Loading restrictive ruleset');
      securitySettings = VaultSecurityManager.presets.readOnly();
    } else {
      Debug.log('✅ READ-ONLY MODE DEACTIVATED - Loading permissive ruleset');
      // Minimal security - just path validation and .mcpignore blocking
      securitySettings = {
        pathValidation: 'strict' as const,  // Always validate paths for security
        permissions: {
          read: true,
          create: true,
          update: true,
          delete: true,
          move: true,
          rename: true,
          execute: true
        },
        blockedPaths: [],  // .mcpignore will handle blocking
        logSecurityEvents: false
      };
    }
    
    // Always use SecureObsidianAPI for consistent security layer
    this.obsidianAPI = new SecureObsidianAPI(obsidianApp, undefined, plugin, securitySettings);
    
    // Initialize connection pool and session manager if concurrent sessions are enabled
    if (plugin?.settings?.enableConcurrentSessions) {
      const maxConnections: number = plugin.settings.maxConcurrentConnections ?? 32;
      
      // Initialize session manager
      this.sessionManager = new SessionManager({
        maxSessions: maxConnections,
        sessionTimeout: 3600000, // 1 hour
        checkInterval: 60000 // Check every minute
      });
      this.sessionManager.start();
      
      // Handle session events
      this.sessionManager.on('session-evicted', (data: { session: { sessionId: string }; reason: string }) => {
        // Clean up transport for evicted session
        const transport = this.transports.get(data.session.sessionId);
        if (transport) {
          void transport.close();
          this.transports.delete(data.session.sessionId);
          this.connectionCount = Math.max(0, this.connectionCount - 1);
          Debug.log(`🔚 Evicted session ${data.session.sessionId} (${data.reason}). Connections: ${this.connectionCount}`);
        }
      });
      
      // Initialize connection pool
      this.connectionPool = new ConnectionPool({
        maxConnections,
        maxQueueSize: 100,
        requestTimeout: 30000,
        sessionTimeout: 3600000,
        sessionCheckInterval: 60000,
        workerScript: path.join(plugin.manifest.dir ?? '', 'dist', 'workers', 'semantic-worker.js')
      });
      void this.connectionPool.initialize();

      // Set up connection pool request processing
      this.connectionPool.on('process', (request: PooledRequest) => {
        void (async () => {
          try {
            // Touch session to update activity
            if (request.sessionId && this.sessionManager) {
              this.sessionManager.touchSession(request.sessionId);
            }

            // Extract tool name from method
            const toolName = request.method.replace('tool.', '');
            const tool = semanticTools.find(t => t.name === toolName);

            if (!tool) {
              this.connectionPool!.completeRequest(request.id, {
                id: request.id,
                error: new Error(`Tool not found: ${toolName}`)
              });
              return;
            }

            // Create session-specific API instance if needed
            const sessionAPI = this.getSessionAPI(request.sessionId);

            // Check if this operation needs data preparation for worker threads
            await this.prepareWorkerContext(request);

            // Execute tool with session context
            const result = await tool.handler(sessionAPI, request.params);

            this.connectionPool!.completeRequest(request.id, {
              id: request.id,
              result
            });
          } catch (error) {
            this.connectionPool!.completeRequest(request.id, {
              id: request.id,
              error
            });
          }
        })();
      });
      
      // Initialize MCP Server Pool for concurrent sessions
      this.mcpServerPool = new MCPServerPool(this.obsidianAPI, maxConnections, plugin);
      
      // Set contexts for session-info resource
      this.mcpServerPool.setContexts(this.sessionManager, this.connectionPool);
      
      Debug.log(`🏊 Connection pool initialized with max ${maxConnections} connections`);
    } else {
      // Initialize single MCP Server for non-concurrent mode
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Using Server (not McpServer) for JSON Schema support
      this.mcpServer = new MCPServer(
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
      this.setupMCPHandlers();
    }
    
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMCPHandlers(): void {
    // Only set up handlers for non-concurrent mode
    // In concurrent mode, each server in the pool has its own handlers
    if (!this.mcpServer) return;

    // Get available tools
    const availableTools = createSemanticTools(this.obsidianAPI);

    // List tools handler
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      Debug.log('📋 Listing available tools');
      return {
        tools: availableTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      };
    });

    // Call tool handler
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      Debug.log(`🔧 Executing tool: ${name}`, args);

      const tool = availableTools.find(t => t.name === name);
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
        const result = await tool.handler(this.obsidianAPI, args || {});
        return result as CallToolResult;
      } catch (error) {
        Debug.error(`Tool execution error (${name}):`, error);
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
    this.mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      Debug.log('📋 Listing available resources');
      return { resources };
    });

    // Read resource handler
    this.mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      Debug.log(`📖 Reading resource: ${uri}`);

      if (uri === 'obsidian://vault-info') {
        const vaultName = this.obsidianApp.vault.getName();
        const activeFile = this.obsidianApp.workspace.getActiveFile();
        const allFiles = this.obsidianApp.vault.getAllLoadedFiles();
        const markdownFiles = this.obsidianApp.vault.getMarkdownFiles();

        const vaultInfo = {
          vault: {
            name: vaultName,
            path: (this.obsidianApp.vault.adapter as unknown as VaultAdapterWithBasePath).basePath ?? 'Unknown'
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
            transport: 'HTTP MCP via Express.js + MCP SDK'
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
  }

  private setupMiddleware(): void {
    // CORS middleware for Claude Code and MCP clients
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id']
    }));

    // JSON body parser
    this.app.use(express.json());
    
    // Request logging for debugging (moved before auth to see all requests)
    this.app.use((req, res, next) => {
      Debug.log(`📡 ${req.method} ${req.url}`, {
        headers: req.headers,
        body: req.body ? JSON.stringify(req.body).substring(0, 200) : ''
      });
      next();
    });
    
    // Authentication middleware - check API key
    this.app.use((req, res, next) => {
      // Skip auth for OPTIONS requests (CORS preflight)
      if (req.method === 'OPTIONS') {
        return next();
      }
      
      // Check if auth is disabled
      if (this.plugin?.settings?.dangerouslyDisableAuth === true) {
        Debug.log('⚠️ Authentication is DISABLED - allowing access without credentials');
        return next();
      }

      const apiKey = this.plugin?.settings?.apiKey;
      if (!apiKey) {
        // No API key configured, allow access (backward compatibility)
        Debug.log('🔓 No API key configured, allowing access');
        return next();
      }
      
      // Check Authorization header for Bearer or Basic Auth
      const authHeader = req.headers.authorization;
      Debug.log(`🔐 Auth check - Header present: ${!!authHeader}, API key set: ${!!apiKey}`);
      
      if (!authHeader) {
        Debug.log('❌ Auth failed: Missing Authorization header');
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      
      let authenticated = false;
      
      // Check for Bearer token
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        authenticated = (token === apiKey);
        Debug.log(`🔐 Bearer auth - Token matches: ${authenticated}`);
      } 
      // Check for Basic auth
      else if (authHeader.startsWith('Basic ')) {
        const base64Credentials = authHeader.slice(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const [username, password] = credentials.split(':');
        authenticated = (password === apiKey);
        Debug.log(`🔐 Basic auth - Username: ${username}, Password matches: ${authenticated}`);
      } else {
        Debug.log('❌ Auth failed: Invalid Authorization header format');
      }
      
      if (!authenticated) {
        Debug.log('❌ Auth failed: Invalid API key');
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }
      
      Debug.log('✅ Auth successful');
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/', (req, res) => {
      const response = {
        name: 'Semantic Notes Vault MCP',
        version: getVersion(),
        status: 'running',
        vault: this.obsidianApp.vault.getName(),
        timestamp: new Date().toISOString()
      };
      
      Debug.log('📊 Health check requested');
      res.json(response);
    });

    // MCP discovery endpoints
    this.app.get('/.well-known/appspecific/com.mcp.obsidian-mcp', (req, res) => {
      const isHttps = this.plugin?.settings?.httpsEnabled === true;
      const protocol = isHttps ? 'https' : 'http';
      res.json({
        endpoint: `${protocol}://localhost:${this.port}/mcp`,
        protocol: protocol,
        method: 'POST',
        contentType: 'application/json'
      });
    });

    // GET endpoint for MCP info (for debugging)
    this.app.get('/mcp', (req, res) => {
      res.json({
        message: 'MCP endpoint active',
        usage: 'POST /mcp with MCP protocol messages',
        protocol: 'Model Context Protocol',
        transport: 'HTTP',
        sessionHeader: 'Mcp-Session-Id'
      });
    });

    // MCP protocol endpoint - using StreamableHTTPServerTransport
    this.app.post('/mcp', (req, res) => {
      void this.handleMCPRequest(req, res);
    });

    // Handle session deletion
    this.app.delete('/mcp', (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string;

      if (sessionId && this.transports.has(sessionId)) {
        const transport = this.transports.get(sessionId)!;
        void transport.close();
        this.transports.delete(sessionId);
        this.connectionCount = Math.max(0, this.connectionCount - 1);
        Debug.log(`🔚 Closed MCP session: ${sessionId} (Remaining: ${this.connectionCount})`);
        res.status(200).json({ message: 'Session closed' });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });
  }

  private async handleMCPRequest(req: express.Request, res: express.Response): Promise<void> {
    try {
      const request = req.body as JsonRpcRequest | undefined;

      // Get or create session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      Debug.log(`📨 MCP Request: ${request?.method ?? 'unknown'}${sessionId ? ` [Session: ${sessionId}]` : ''}`, request?.params);
      // Quick path: lightweight ping to keep session alive
      if (request?.method === 'session/ping' || request?.method === 'status/ping') {
        if (sessionId && this.sessionManager) {
          this.sessionManager.touchSession(sessionId);
        }
        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }
        res.status(200).json({ jsonrpc: '2.0', id: request?.id ?? null, result: { ok: true, sessionId: sessionId || null } });
        return;
      }
      let transport: StreamableHTTPServerTransport | undefined;
      let effectiveSessionId!: string; // will be set in the branches below
      if (sessionId) {
        effectiveSessionId = sessionId;
      }
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      let mcpServer: MCPServer;

      // Helper: create a null response shim so we can send an internal initialize
      const createNullRes = (): NullResponse => {
        const headers: Record<string, string> = {};
        let sent = false;
        let code = 200;
        const resp: NullResponse = {
          // Node-style response interface (minimal no-op implementation)
          writeHead: (_status: number, _headers?: Record<string, string>) => { code = _status; sent = true; },
          setHeader: (k: string, v: string) => { headers[k] = v; },
          getHeader: (k: string) => headers[k],
          get statusCode() { return code; },
          set statusCode(v: number) { code = v; },
          get headersSent() { return sent; },
          write: (_chunk: unknown) => { /* no-op */ },
          end: (_data?: unknown) => { sent = true; },
          on: (_event: string, _handler: (...args: unknown[]) => void) => { /* no-op */ },
          once: (_event: string, _handler: (...args: unknown[]) => void) => { /* no-op */ },
          // Express-like helpers (used by some wrappers)
          status: (v: number) => { code = v; return resp; },
          json: (_body: unknown) => { sent = true; },
          send: (_body?: unknown) => { sent = true; },
        };
        return resp;
      };
      // When a non-initialize request arrives without an active transport,
      // we return a JSON-RPC error instructing the client to initialize using
      // the provided session ID. This avoids fragile internal auto-initialize.
      let requireInitializeNotice = false;

      // Helper: register transport with lifecycle hooks
      const attachTransportHandlers = (sessId: string, tr: StreamableHTTPServerTransport) => {
        try {
          // Transport may optionally support EventEmitter API
          const emitter = tr as unknown as { on?: (event: string, handler: (...args: unknown[]) => void) => void };
          if (typeof emitter.on === 'function') {
            emitter.on('close', () => {
              if (this.transports.has(sessId)) {
                this.transports.delete(sessId);
                this.connectionCount = Math.max(0, this.connectionCount - 1);
                Debug.log(`🔌 Transport closed for session ${sessId}. Connections: ${this.connectionCount}`);
              }
            });
            emitter.on('error', (e: unknown) => {
              Debug.error(`Transport error for session ${sessId}:`, e);
              if (this.transports.has(sessId)) {
                this.transports.delete(sessId);
                this.connectionCount = Math.max(0, this.connectionCount - 1);
              }
            });
          }
        } catch {
          // Transport may not support event emitters, which is fine
        }
      };

      // Determine which server to use
      if (this.mcpServerPool) {
        // Concurrent mode - use server pool
        if (sessionId && this.transports.has(sessionId)) {
          // Use existing transport for this session
          transport = this.transports.get(sessionId)!;
          
          // Get the server for this session (it should already exist)
          mcpServer = this.mcpServerPool.getOrCreateServer(sessionId);
          
          // Update session activity
          if (this.sessionManager) {
            this.sessionManager.touchSession(sessionId);
          }
        } else if (sessionId && this.sessionManager) {
          // Session ID provided but no active transport
          // Only allow re-create on initialize; otherwise signal explicit session expiration
          if (isInitializeRequest(request)) {
            const session = this.sessionManager.getOrCreateSession(sessionId);
            mcpServer = this.mcpServerPool.getOrCreateServer(sessionId);
            effectiveSessionId = sessionId;
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => effectiveSessionId
            });
            await mcpServer.connect(transport);
            this.transports.set(effectiveSessionId, transport);
            attachTransportHandlers(effectiveSessionId, transport);
            this.connectionCount++;
            Debug.log(`♻️ Recreated transport for session ${sessionId} (requests: ${session.requestCount})`);
          } else {
            // Create transport and require client initialize on next call
            const newSessionId = sessionId; // reuse provided id (guaranteed by branch)
            mcpServer = this.mcpServerPool.getOrCreateServer(newSessionId);
            effectiveSessionId = newSessionId;
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => effectiveSessionId
            });
            await mcpServer.connect(transport);
            this.transports.set(effectiveSessionId, transport);
            attachTransportHandlers(effectiveSessionId, transport);
            this.connectionCount++;
            requireInitializeNotice = true;
          }
        } else if (!sessionId && isInitializeRequest(request)) {
          // New initialization request - create new transport with session
          effectiveSessionId = randomUUID();
          
          // Get or create server for this session
          mcpServer = this.mcpServerPool.getOrCreateServer(effectiveSessionId);
          
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => effectiveSessionId
          });
          
          // Connect the MCP server to this transport
          await mcpServer.connect(transport);
          
          // Store the transport for future requests
          this.transports.set(effectiveSessionId, transport);
          attachTransportHandlers(effectiveSessionId, transport);
          this.connectionCount++;
          
          // Register session with manager if enabled
          if (this.sessionManager) {
            this.sessionManager.getOrCreateSession(effectiveSessionId);
          }
        } else {
          // No or unknown session on non-initialize request.
          // Generate a session (or reuse provided) and require client initialize next.
          const newSessionId = sessionId ?? randomUUID();
          mcpServer = this.mcpServerPool.getOrCreateServer(newSessionId);
          effectiveSessionId = newSessionId;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => effectiveSessionId
          });
          await mcpServer.connect(transport);
          this.transports.set(effectiveSessionId, transport);
          attachTransportHandlers(effectiveSessionId, transport);
          this.connectionCount++;
          requireInitializeNotice = true;
        }
      } else {
        // Non-concurrent mode - use single MCP server
        mcpServer = this.mcpServer!;
        if (sessionId && this.transports.has(sessionId)) {
          // Use existing transport
          transport = this.transports.get(sessionId)!;
          effectiveSessionId = sessionId;
          if (this.sessionManager) this.sessionManager.touchSession(sessionId);
        } else if (sessionId) {
          // No active transport for provided session
          if (isInitializeRequest(request)) {
            effectiveSessionId = sessionId;
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => effectiveSessionId });
            await mcpServer.connect(transport);
            this.transports.set(effectiveSessionId, transport);
            attachTransportHandlers(effectiveSessionId, transport);
            this.connectionCount++;
          } else {
            effectiveSessionId = sessionId;
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => effectiveSessionId });
            await mcpServer.connect(transport);
            this.transports.set(effectiveSessionId, transport);
            attachTransportHandlers(effectiveSessionId, transport);
            this.connectionCount++;
            requireInitializeNotice = true;
          }
        } else if (!sessionId && isInitializeRequest(request)) {
          // New initialization request - create new session and transport
          effectiveSessionId = randomUUID();
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => effectiveSessionId });
          await mcpServer.connect(transport);
          this.transports.set(effectiveSessionId, transport);
          attachTransportHandlers(effectiveSessionId, transport);
          this.connectionCount++;
          if (this.sessionManager) {
            this.sessionManager.getOrCreateSession(effectiveSessionId);
          }
        } else {
          // No session header and not an initialize request: pre-provision session and require initialize
          effectiveSessionId = randomUUID();
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => effectiveSessionId });
          await mcpServer.connect(transport);
          this.transports.set(effectiveSessionId, transport);
          attachTransportHandlers(effectiveSessionId, transport);
          this.connectionCount++;
          if (this.sessionManager) {
            this.sessionManager.getOrCreateSession(effectiveSessionId);
          }
          requireInitializeNotice = true;
        }
      }

      // Compatibility: if we just created a transport for a non-initialize call,
      // attempt a safe, internal initialize to avoid client retry loops.
      if (requireInitializeNotice && transport && !isInitializeRequest(request)) {
        // Clone req to ensure session header is present for compat initialize
        const compatReq = {
          ...req,
          headers: {
            ...req.headers,
            'mcp-session-id': effectiveSessionId
          }
        } as unknown as IncomingMessage;
        const versionsToTry = ['2025-06-18', '2024-11-05', '1.0'];
        let initOk = false;
        for (const ver of versionsToTry) {
          try {
            const initReq = {
              jsonrpc: '2.0',
              id: '__compat_init__',
              method: 'initialize',
              params: {
                protocolVersion: ver,
                capabilities: {},
                clientInfo: { name: 'obsidian-mcp-compat', version: getVersion() }
              }
            } as unknown;
            await transport.handleRequest(compatReq, createNullRes() as unknown as ServerResponse, initReq);
            initOk = true;
            Debug.log(`Compat initialize succeeded with protocolVersion=${ver}`);
            break;
          } catch (e) {
            Debug.error(`Compat initialize attempt failed (protocolVersion=${ver}):`, e);
          }
        }
        // Fail-open: even if initialize failed, proceed with the original request
        // to avoid client retry loops. The transport/server may still reject it,
        // but this gives us a concrete server error to act on.
        requireInitializeNotice = false;
        if (!initOk) {
          Debug.log('Compat initialize failed; proceeding without explicit initialize (fail-open).');
        }
      }

      // If initialization is still required and this isn't an initialize request,
      // instruct the client to initialize for this session.
      if (requireInitializeNotice && !isInitializeRequest(request)) {
        const id = request?.id ?? null;
        res.setHeader('Mcp-Session-Id', effectiveSessionId);
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Server not initialized',
            data: { sessionId: effectiveSessionId }
          },
          id
        });
        return;
      }

      // Safety: ensure we have a transport before forwarding
      if (!transport) {
        const id = request?.id ?? null;
        if (effectiveSessionId) {
          res.setHeader('Mcp-Session-Id', effectiveSessionId);
        }
        res.status(200).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'No active transport/session. Please initialize and retry.', data: effectiveSessionId ? { sessionId: effectiveSessionId } : undefined },
          id
        });
        return;
      }

      // Handle the request using the transport
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        request as unknown
      );
      
      Debug.log('📤 MCP Response sent via transport');

    } catch (error) {
      Debug.error('❌ MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error: ' + (error instanceof Error ? error.message : 'Unknown error')
          },
          id: null
        });
      }
    }
  }


  async start(): Promise<void> {
    if (this.isRunning) {
      Debug.log(`MCP server already running on port ${this.port}`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      // Create HTTP or HTTPS server based on configuration
      const certificateConfig: CertificateConfig = this.plugin?.settings?.certificateConfig ?? { enabled: false };

      // Initialize certificate manager lazily if HTTPS is enabled
      if (this.isHttps && !this.certificateManager) {
        try {
          this.certificateManager = new CertificateManager(this.obsidianApp);
        } catch (error) {
          Debug.error('Failed to initialize certificate manager:', error);
          // Fall back to HTTP if certificate manager fails
          this.isHttps = false;
        }
      }

      // Create server - use certificate manager if available and HTTPS is enabled
      if (this.isHttps && this.certificateManager) {
        this.server = this.certificateManager.createServer(this.app, certificateConfig, this.port);
      } else {
        // Create standard HTTP server
        this.server = createHttpServer(this.app);
      }

      const protocol = this.isHttps ? 'https' : 'http';

      if (!this.server) {
        reject(new Error('Failed to create server'));
        return;
      }

      // Configure server timeouts to keep connections healthy and prevent hangs
      try {
        const serverWithTimeouts = this.server as unknown as ServerWithTimeouts;
        // Keep connections alive long enough for clients, but not indefinitely
        serverWithTimeouts.keepAliveTimeout = 60_000; // 60s
        // Headers timeout should exceed keepAliveTimeout slightly
        serverWithTimeouts.headersTimeout = 65_000; // 65s
        // Per-request timeout; 0 to disable, or a generous value
        serverWithTimeouts.requestTimeout = 120_000; // 120s
        // Legacy idle timeout fallback
        if (typeof serverWithTimeouts.setTimeout === 'function') {
          serverWithTimeouts.setTimeout(120_000);
        }
        Debug.log('⏱️ Server timeouts configured (keepAlive=60s, headers=65s, request=120s)');
      } catch (e) {
        Debug.error('Failed to configure server timeouts:', e);
      }
      
      this.server.listen(this.port, () => {
        this.isRunning = true;
        Debug.log(`🚀 MCP server started on ${protocol}://localhost:${this.port}`);
        Debug.log(`📍 Health check: ${protocol}://localhost:${this.port}/`);
        Debug.log(`🔗 MCP endpoint: ${protocol}://localhost:${this.port}/mcp`);
        
        if (this.isHttps) {
          Debug.log('🔒 HTTPS enabled with certificate');
          new Notice(`MCP server running on HTTPS port ${this.port}`);
        }
        
        resolve();
      });

      this.server.on('error', (error: unknown) => {
        this.isRunning = false;
        Debug.error('❌ Failed to start MCP server:', error);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      return;
    }

    // Clean up all active transports
    for (const [sessionId, transport] of this.transports) {
      void transport.close();
      Debug.log(`🔚 Closed MCP session on shutdown: ${sessionId}`);
    }
    this.transports.clear();
    this.connectionCount = 0; // Reset connection count on server stop

    // Shutdown session manager if it exists
    if (this.sessionManager) {
      this.sessionManager.stop();
    }

    // Shutdown connection pool if it exists
    if (this.connectionPool) {
      await this.connectionPool.shutdown();
    }

    // Shutdown MCP server pool if it exists
    if (this.mcpServerPool) {
      await this.mcpServerPool.shutdown();
    }

    return new Promise<void>((resolve) => {
      this.server?.close(() => {
        this.isRunning = false;
        Debug.log('👋 MCP server stopped');
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getConnectionCount(): number {
    return this.connectionCount;
  }

  /**
   * Get connection pool statistics
   */
  getConnectionPoolStats(): ConnectionPoolStatsResponse {
    if (!this.connectionPool) {
      return { enabled: false };
    }

    const result: ConnectionPoolStatsResponse = {
      enabled: true,
      stats: this.connectionPool.getStats()
    };

    // Include MCP server pool stats if available
    if (this.mcpServerPool) {
      const poolStats = this.mcpServerPool.getStats();
      result.serverPoolStats = {
        activeServers: poolStats.activeServers,
        maxServers: poolStats.maxServers,
        utilization: poolStats.utilization,
        totalRequests: poolStats.totalRequests
      };
    }

    return result;
  }

  /**
   * Get or create a session-specific API instance
   */
  private getSessionAPI(sessionId?: string): ObsidianAPI {
    if (!sessionId) {
      return this.obsidianAPI;
    }

    // For now, return the same API instance
    // In the future, we could create session-specific instances with isolated state
    return this.obsidianAPI;
  }

  /**
   * Prepare context data for worker thread operations
   */
  private async prepareWorkerContext(request: PooledRequest): Promise<unknown> {
    // Only prepare context for worker-compatible operations
    const workerOps = [
      'tool.vault.search',
      'tool.vault.fragments',
      'tool.graph.search-traverse',
      'tool.graph.advanced-traverse'
    ];
    
    if (!workerOps.some(op => request.method.includes(op))) {
      return undefined;
    }
    
    Debug.log(`📦 Preparing worker context for ${request.method}`);
    
    // For search operations, we might need to pre-fetch file contents
    if (request.method.includes('vault.search')) {
      // This would be implemented based on the specific needs
      // For now, return undefined to use main thread
      return undefined;
    }
    
    // For graph operations, we need file contents and link graph
    if (request.method.includes('graph.search-traverse')) {
      try {
        const params = request.params as Record<string, unknown> | undefined;
        const startPath = typeof params?.startPath === 'string' ? params.startPath : undefined;
        if (!startPath) return undefined;

        // Get initial file and its links
        const file = this.obsidianApp.vault.getAbstractFileByPath(startPath);
        if (!file || !('extension' in file)) return undefined;

        // This would need more sophisticated pre-fetching logic
        // For now, return undefined to use main thread
        return undefined;
      } catch (error) {
        Debug.error('Failed to prepare worker context:', error);
        return undefined;
      }
    }
    
    return undefined;
  }
}