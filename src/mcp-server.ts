import express from 'express';
import cors from 'cors';
import { App, Notice } from 'obsidian';
import { createServer as createHttpServer, Server } from 'http';
import { Server as HttpsServer } from 'https';
import { McpServer as MCPServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { getVersion } from './version';
import { ObsidianAPI } from './utils/obsidian-api';
import { SecureObsidianAPI, VaultSecurityManager } from './security';
import { semanticTools } from './tools/semantic-tools';
import { Debug } from './utils/debug';
import { ConnectionPool, PooledRequest } from './utils/connection-pool';
import { SessionManager } from './utils/session-manager';
import { MCPServerPool } from './utils/mcp-server-pool';
import { CertificateManager, CertificateConfig } from './utils/certificate-manager';
import {
  classifyFromSettings,
  resolveListenHost,
  agentInstructionsForVerdict,
  BindMode,
  Verdict
} from './utils/network-classifier';

/** Minimal plugin interface for MCPHttpServer.
 * Includes fields from SecurePluginRef and ObsidianAPIPluginRef so the same object
 * can be passed through the constructor chain. */
interface MCPPluginRef {
  settings?: {
    httpsEnabled?: boolean;
    httpsPort?: number;
    httpPort?: number;
    certificateConfig?: CertificateConfig;
    // ADR-107: bind mode + custom host
    bindMode?: BindMode;
    customBindHost?: string;
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
  // Assigned unconditionally in the constructor. Non-optional so the
  // "initialize is never short-circuited as a terminated session" invariant
  // (ADR-106) is guaranteed by the type system, not just construction order.
  private sessionManager: SessionManager;
  private certificateManager: CertificateManager | null;
  private isHttps: boolean = false;
  // ADR-107: resolved at bind time, consumed by initialize.instructions
  private currentVerdict?: Verdict;
  private resolvedListenHost: string = '127.0.0.1';

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
      sessionCheckInterval: 60000
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

    // Debug/info endpoint — moved off `GET /mcp` so it no longer shadows the
    // SSE stream the client opens with `GET /mcp` (the shadowing caused the
    // SSE reconnection loop in #125).
    this.app.get('/mcp-info', (req, res) => {
      res.json({
        message: 'MCP endpoint active',
        usage: 'POST /mcp for messages, GET /mcp for the SSE stream',
        protocol: 'Model Context Protocol',
        transport: 'HTTP',
        sessionHeader: 'Mcp-Session-Id'
      });
    });

    // MCP protocol endpoint — StreamableHTTPServerTransport. POST carries
    // messages, GET establishes the SSE stream; both go to the same handler.
    // DELETE keeps its own explicit session-close handler below, so we route
    // GET/POST individually rather than `app.all` (which would shadow it).
    this.app.post('/mcp', (req, res) => {
      void this.handleMCPRequest(req, res);
    });
    this.app.get('/mcp', (req, res) => {
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

  /**
   * Emit the Streamable HTTP spec's session-lifecycle signal so the client
   * can recover a dropped/evicted session on its own (client-driven re-init,
   * ADR-106).
   *
   * - If the request carried an `Mcp-Session-Id` we no longer hold a
   *   transport for, the session is terminated: respond **HTTP 404**
   *   (Session Management §3). A spec-compliant client/bridge MUST then
   *   start a new session by sending a fresh `InitializeRequest` with no
   *   session ID (§4) — no client restart required, fixing #128.
   * - If no `Mcp-Session-Id` was sent on a non-initialize request, a session
   *   is required: respond **HTTP 400** (§2).
   *
   * The HTTP status is the load-bearing signal; the JSON-RPC error body is
   * courtesy for clients that surface it. We deliberately do not attempt a
   * server-side synthetic initialize — that cannot drive SDK 1.29's
   * web-standard transport to an initialized state (see #190).
   */
  private sendSessionTerminated(
    res: express.Response,
    request: JsonRpcRequest | undefined,
    sessionId: string | undefined
  ): void {
    const id = request?.id ?? null;
    if (sessionId) {
      // Spec §3: terminated session → 404; client re-inits per §4.
      res.setHeader('Mcp-Session-Id', sessionId);
      res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session expired or not found. Start a new session by sending an initialize request without a session ID.',
          data: { sessionId }
        },
        id
      });
      Debug.log(`🔁 Session ${sessionId} terminated → 404 (client should re-initialize per MCP spec §4)`);
      return;
    }
    // Spec §2: session required for non-initialize requests → 400.
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Bad Request: a session is required. Send an initialize request first.'
      },
      id
    });
    Debug.log('⚠️ Non-initialize request with no session id → 400 (session required)');
  }

  private async handleMCPRequest(req: express.Request, res: express.Response): Promise<void> {
    try {
      const request = req.body as JsonRpcRequest | undefined;

      // Get or create session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      Debug.log(`📨 MCP Request: ${request?.method ?? 'unknown'}${sessionId ? ` [Session: ${sessionId}]` : ''}`, request?.params);

      // `GET /mcp` opens the standalone SSE notification stream — long-lived and
      // idle by design (this server pushes no server-initiated notifications).
      // The global 120s socket timeout set in start() would otherwise reap it
      // every ~2 min, surfacing as a "stream terminated" reconnect churn in
      // bridges and noisy logs (#221). Disable the idle timeout on this GET
      // socket; POST request sockets keep the server-wide default. (A non-SSE
      // GET is short-lived — its response is sent immediately — so the
      // exemption is a harmless no-op for those.)
      //
      // Trade-off: with no socket-layer idle reap, a truly-dead SSE socket
      // (client vanished without a FIN) is no longer dropped at ~2 min. The
      // backstop is the SessionManager's 1h idle eviction, which calls
      // transport.close() and thereby closes the socket — so abandoned streams
      // are bounded by that timeout and the 32-session cap, not leaked
      // unbounded. A long finite timeout was weighed against 0; the choice is
      // deferred to the live-instance validation, since a finite value would
      // reintroduce some (less frequent) reconnect churn.
      if (req.method === 'GET') {
        req.socket?.setTimeout(0);
      }
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
          let mcpServer: MCPServer;

      // Transport cleanup is handled by two existing paths, so there is no
      // per-transport close hook here:
      //   • idle eviction — the SessionManager emits `session-evicted`, whose
      //     handler (see constructor) calls `transport.close()` and drops the
      //     map entry; every transport maps to a manager-tracked session that
      //     is eventually idle-evicted, so none leaks permanently.
      //   • explicit teardown — the DELETE /mcp handler closes + removes it.
      // A prior `transport.on('close'|'error')` helper here was dead code:
      // SDK 1.29's StreamableHTTPServerTransport is not an EventEmitter and has
      // no `.on`, so it never fired. Its only correct hook would be the
      // `onclose` callback, which would merely duplicate the two paths above.

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
            this.connectionCount++;
            Debug.log(`♻️ Recreated transport for session ${sessionId} (requests: ${session.requestCount})`);
          } else {
            // Stale/evicted session: the client presented an Mcp-Session-Id
            // we no longer hold a transport for, and this is not an
            // initialize request. Per the Streamable HTTP spec (Session
            // Management §3) the server MUST respond HTTP 404 for a
            // terminated session; per §4 the client must then start a new
            // session by sending a fresh InitializeRequest with no session
            // ID. We do NOT fabricate a transport or attempt a server-side
            // synthetic initialize — that cannot drive SDK 1.29's
            // web-standard transport to an initialized state (ADR-106 /
            // #190) and only produces an unrecoverable 400 loop (#128).
            this.sendSessionTerminated(res, request, sessionId);
            return;
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
          this.connectionCount++;
          
          // Register session with manager if enabled
          if (this.sessionManager) {
            this.sessionManager.getOrCreateSession(effectiveSessionId);
          }
        } else {
          // Non-initialize request with no usable session. Either:
          //  - an Mcp-Session-Id we don't hold a transport for → spec §3
          //    terminated-session signal (HTTP 404), client re-inits per §4;
          //  - no Mcp-Session-Id at all and not an initialize → spec §2
          //    "session required" (HTTP 400).
          // sendSessionTerminated picks the status from sessionId presence.
          // No phantom transport, no synthetic initialize (see #190/#128).
          this.sendSessionTerminated(res, request, sessionId);
          return;
        }

      // Safety: every reachable path above either bound a live `transport`
      // (existing session, recreate-on-initialize, fresh initialize) or
      // returned a spec-compliant terminated/required-session response. A
      // missing transport here is an unexpected invariant break, not a stale
      // session — surface it explicitly rather than papering it.
      if (!transport) {
        Debug.error('Invariant: no transport after session resolution');
        this.sendSessionTerminated(res, request, sessionId);
        return;
      }

      // Handle the request using the transport
      await transport.handleRequest(
        req,
        res,
        request
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
      
      // ADR-107: resolve bind host from settings and classify the combined state
      const bindMode = this.plugin?.settings?.bindMode ?? 'loopback';
      const customHost = this.plugin?.settings?.customBindHost ?? '';
      this.resolvedListenHost = resolveListenHost(bindMode, customHost);
      this.currentVerdict = classifyFromSettings({
        httpsEnabled: this.isHttps,
        bindMode,
        customBindHost: customHost,
        userSuppliedCert: !!(this.plugin?.settings?.certificateConfig?.certPath
          && this.plugin?.settings?.certificateConfig?.keyPath)
      });
      // Push the agent-visible warning to the server pool so subsequent
      // sessions surface it in MCP initialize.instructions.
      this.mcpServerPool.setInitializeInstructions(
        agentInstructionsForVerdict(this.currentVerdict, this.resolvedListenHost, this.port)
      );

      this.server.listen(this.port, this.resolvedListenHost, () => {
        this.isRunning = true;
        const host = this.resolvedListenHost;
        Debug.log(`🚀 MCP server started on ${protocol}://${host}:${this.port}`);
        Debug.log(`📍 Health check: ${protocol}://${host}:${this.port}/`);
        Debug.log(`🔗 MCP endpoint: ${protocol}://${host}:${this.port}/mcp`);

        if (this.isHttps) {
          Debug.log('🔒 HTTPS enabled with certificate');
          new Notice(`MCP server running on HTTPS port ${this.port}`);
        }

        // ADR-107: act on the classified verdict
        const verdict = this.currentVerdict!;
        if (verdict.class === 'jail') {
          Debug.error(`🚨 Network exposure: ${verdict.reason}`);
          new Notice(
            `⚠️ MCP server is serving vault contents over an unencrypted network interface (${host}:${this.port}). ` +
              'API key and document text travel in cleartext. Reconfigure to HTTPS or loopback in the plugin settings.',
            15000
          );
        } else if (verdict.class === 'warn') {
          Debug.warn(`⚠️ Network exposure: ${verdict.reason}`);
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
}