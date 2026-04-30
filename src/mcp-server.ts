import express from 'express';
import cors from 'cors';
import { App, Notice } from 'obsidian';
import { createServer as createHttpServer, Server, IncomingMessage, ServerResponse } from 'http';
import { Server as HttpsServer } from 'https';
import { PassThrough } from 'stream';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { getVersion } from './version';
import { ObsidianAPI } from './utils/obsidian-api';
import { SecureObsidianAPI, VaultSecurityManager } from './security';
import { semanticTools } from './tools/semantic-tools';
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
  private mcpServerPool!: MCPServerPool;
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
  private startTime: number = Date.now();

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
    
    // Initialize connection pool and session manager (always concurrent)
    const maxConnections = 32;

    this.sessionManager = new SessionManager({
      maxSessions: maxConnections,
      sessionTimeout: 3600000, // 1 hour
      checkInterval: 60000 // Check every minute
    });
    this.sessionManager.start();

    // Handle session events
    this.sessionManager.on('session-evicted', (data: { session: { sessionId: string }; reason: string }) => {
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
      workerScript: path.join(plugin?.manifest.dir ?? '', 'dist', 'workers', 'semantic-worker.js')
    });
    void this.connectionPool.initialize();

    // Set up connection pool request processing
    this.connectionPool.on('process', (request: PooledRequest) => {
      void (async () => {
        try {
          if (request.sessionId && this.sessionManager) {
            this.sessionManager.touchSession(request.sessionId);
          }

          const toolName = request.method.replace('tool.', '');
          const tool = semanticTools.find(t => t.name === toolName);

          if (!tool) {
            this.connectionPool!.completeRequest(request.id, {
              id: request.id,
              error: new Error(`Tool not found: ${toolName}`)
            });
            return;
          }

          const sessionAPI = this.getSessionAPI(request.sessionId);
          this.prepareWorkerContext(request);
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

    // Initialize MCP Server Pool
    this.mcpServerPool = new MCPServerPool(this.obsidianAPI, maxConnections, plugin);
    this.mcpServerPool.setContexts(this.sessionManager, this.connectionPool);

    Debug.log(`🏊 Connection pool initialized with max ${maxConnections} connections`);
    
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
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
      let sessionId = req.headers['mcp-session-id'] as string;

      // Resolve alias if the session ID is stale
      if (sessionId && !this.transports.has(sessionId) && this.sessionManager) {
        const aliasTarget = this.sessionManager.resolveAlias(sessionId);
        if (aliasTarget) sessionId = aliasTarget;
      }

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

      // Get session ID from header; may be resolved via alias below
      let sessionId = req.headers['mcp-session-id'] as string | undefined;
      const originalSessionId = sessionId; // preserve for alias tracking
      Debug.log(`📨 MCP Request: ${request?.method ?? 'unknown'}${sessionId ? ` [Session: ${sessionId}]` : ''}`, request?.params);

      // Quick path: lightweight ping to keep session alive
      if (request?.method === 'session/ping' || request?.method === 'status/ping') {
        if (sessionId && this.sessionManager) {
          // Try alias resolution for pings too
          const aliasTarget = this.sessionManager.resolveAlias(sessionId);
          if (aliasTarget) sessionId = aliasTarget;
          this.sessionManager.touchSession(sessionId);
        }
        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }
        res.status(200).json({ jsonrpc: '2.0', id: request?.id ?? null, result: { ok: true, sessionId: sessionId || null } });
        return;
      }

      // Resolve session aliases before the main branching logic.
      // If the client sends a stale session ID that was previously healed,
      // the alias resolves it to the active session without re-running compat init.
      let resolvedFromAlias = false;
      if (sessionId && this.sessionManager && !this.transports.has(sessionId)) {
        const aliasTarget = this.sessionManager.resolveAlias(sessionId);
        if (aliasTarget && this.transports.has(aliasTarget)) {
          Debug.log(`🔗 Resolved session alias: ${sessionId} → ${aliasTarget}`);
          sessionId = aliasTarget;
          resolvedFromAlias = true;
        }
      }

      let transport: StreamableHTTPServerTransport | undefined;
      let effectiveSessionId!: string; // will be set in the branches below
      if (sessionId) {
        effectiveSessionId = sessionId;
      }
      let mcpServer: MCPServer;

      // When a non-initialize request arrives without an active transport,
      // we attempt an internal compat-initialize. If that fails, we return
      // a structured JSON-RPC error instead of a vague HTTP 400.
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

      // Determine which server to use from the pool
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
          // Session ID provided but no active transport.
          // For initialize requests: recreate transport directly.
          // For non-initialize: create transport and attempt compat init.
          if (isInitializeRequest(request)) {
            // Initialize always recovers — ignore stale session state
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
            // Create transport and attempt compat init below
            const newSessionId = sessionId;
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
          // Generate a session (or reuse provided) and attempt compat init.
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

      // Compatibility: if we just created a transport for a non-initialize call,
      // attempt a proper internal initialize using real Node.js HTTP objects
      // so the SDK's transport transitions to _initialized=true.
      if (requireInitializeNotice && transport && !isInitializeRequest(request)) {
        const versionsToTry = ['2025-06-18', '2024-11-05', '1.0'];
        let initOk = false;
        for (const ver of versionsToTry) {
          try {
            const initBody = {
              jsonrpc: '2.0',
              id: '__compat_init__',
              method: 'initialize',
              params: {
                protocolVersion: ver,
                capabilities: {},
                clientInfo: { name: 'obsidian-mcp-compat', version: getVersion() }
              }
            };
            const { req: initReq, res: initRes } = this.createCompatInitPair(effectiveSessionId, initBody);
            await transport.handleRequest(initReq, initRes, initBody);
            // Verify the init actually succeeded by checking response status
            if (initRes.statusCode >= 200 && initRes.statusCode < 300) {
              initOk = true;
              Debug.log(`♻️ Session healed: compat initialize succeeded (protocolVersion=${ver}, session=${effectiveSessionId})`);
              break;
            } else {
              Debug.log(`⚠️ Compat initialize returned status ${initRes.statusCode} (protocolVersion=${ver})`);
            }
          } catch (e) {
            Debug.error(`⚠️ Compat initialize attempt failed (protocolVersion=${ver}):`, e);
          }
        }
        if (initOk) {
          requireInitializeNotice = false;
          // Create alias so subsequent requests with the original stale ID
          // resolve directly without re-running compat init
          if (originalSessionId && originalSessionId !== effectiveSessionId && this.sessionManager) {
            this.sessionManager.createAlias(originalSessionId, effectiveSessionId);
          }
          // Register the healed session with the session manager
          if (this.sessionManager) {
            this.sessionManager.getOrCreateSession(effectiveSessionId);
          }
        } else {
          Debug.log(`⚠️ Session recovery failed for ${request?.method ?? 'unknown'} (session=${effectiveSessionId})`);
        }
      }

      // Always set canonical session ID header so clients can converge
      if (effectiveSessionId) {
        res.setHeader('Mcp-Session-Id', effectiveSessionId);
      }

      // If initialization is still required and this isn't an initialize request,
      // return a structured JSON-RPC error with recovery instructions.
      if (requireInitializeNotice && !isInitializeRequest(request)) {
        const id = request?.id ?? null;
        res.status(200).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'MCP session expired or unknown',
            data: {
              reason: 'unknown_session',
              recoverable: true,
              retry: 'initialize',
              sessionId: effectiveSessionId
            }
          },
          id
        });
        return;
      }

      // Safety: ensure we have a transport before forwarding
      if (!transport) {
        const id = request?.id ?? null;
        res.status(200).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'MCP session expired or unknown',
            data: {
              reason: 'no_transport',
              recoverable: true,
              retry: 'initialize',
              sessionId: effectiveSessionId || undefined
            }
          },
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

      // If the response was handled by an alias-resolved session, log it
      if (resolvedFromAlias) {
        Debug.log(`📤 MCP Response sent via alias-resolved session (original=${originalSessionId})`);
      } else {
        Debug.log('📤 MCP Response sent via transport');
      }

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

  /**
   * Create a proper Node.js IncomingMessage/ServerResponse pair for internal
   * compat-initialize calls. The SDK's StreamableHTTPServerTransport uses
   * Hono's getRequestListener which requires real Node.js HTTP objects —
   * a minimal shim is insufficient.
   */
  private createCompatInitPair(sessionId: string, body: unknown): { req: IncomingMessage; res: ServerResponse } {
    const socket = new PassThrough() as unknown as import('net').Socket;
    const initReq = new IncomingMessage(socket);
    initReq.method = 'POST';
    initReq.url = '/mcp';
    initReq.headers = {
      'content-type': 'application/json',
      'mcp-session-id': sessionId
    };
    // Push the body as stream data so the request is readable
    const bodyStr = JSON.stringify(body);
    initReq.push(bodyStr);
    initReq.push(null);

    const initRes = new ServerResponse(initReq);
    // Pipe response output to a PassThrough to prevent writing to a real socket
    initRes.assignSocket(new PassThrough() as unknown as import('net').Socket);

    return { req: initReq, res: initRes };
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
      this.mcpServerPool.shutdown();
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

  getStartTime(): number {
    return this.startTime;
  }

  getSessionManager(): SessionManager | undefined {
    return this.sessionManager;
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
  private prepareWorkerContext(request: PooledRequest): unknown {
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