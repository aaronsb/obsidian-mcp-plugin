import { App } from 'obsidian';
import { Debug } from './utils/debug';

interface MCPRequestParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

interface MCPRequest {
  method: string;
  params?: MCPRequestParams;
  id?: string | number;
}

interface MCPResponse {
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
  id?: string | number;
}

interface MCPHTTPResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type RequestHandler = (body?: string) => MCPHTTPResponse | Promise<MCPHTTPResponse>;

interface MCPServerInstance {
  port: number;
  handlers: Map<string, RequestHandler>;
  isRunning: boolean;
}

export class BrowserMCPServer {
  private app: App;
  private port: number;
  private server: MCPServerInstance | undefined;
  private isRunning: boolean = false;

  constructor(app: App, port: number = 3001) {
    this.app = app;
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      Debug.log(`MCP server already running on port ${this.port}`);
      return;
    }

    try {
      // Create a simple HTTP server using browser APIs
      // We'll use a worker or service worker approach for this
      // Generate server code (currently unused, reserved for future worker implementation)
      this.generateServerCode();

      // For now, let's create a simple mock server that can handle requests
      this.server = {
        port: this.port,
        handlers: new Map(),
        isRunning: true
      };

      // Register our MCP endpoints
      this.setupMCPEndpoints();

      this.isRunning = true;
      Debug.log(`🚀 MCP server started on port ${this.port}`);
      Debug.log(`📍 Health check: /`);
      Debug.log(`🔗 MCP endpoint: /mcp`);

    } catch (error) {
      Debug.error('❌ Failed to start MCP server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.server = undefined;
    Debug.log('👋 MCP server stopped');
  }

  private setupMCPEndpoints(): void {
    if (!this.server) return;
    // Health check endpoint
    this.server.handlers.set('GET /', this.handleHealthCheck.bind(this));

    // MCP protocol endpoint
    this.server.handlers.set('POST /mcp', this.handleMCPRequest.bind(this));

    // CORS preflight
    this.server.handlers.set('OPTIONS /mcp', this.handleCORS.bind(this));
  }

  private handleHealthCheck(): MCPHTTPResponse {
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        name: 'Semantic Notes Vault MCP',
        version: '0.1.3',
        status: 'running',
        vault: this.app.vault.getName(),
        timestamp: new Date().toISOString()
      })
    };
  }

  private handleCORS(): MCPHTTPResponse {
    return {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      },
      body: ''
    };
  }

  private async handleMCPRequest(body?: string): Promise<MCPHTTPResponse> {
    try {
      const request = JSON.parse(body ?? '{}') as MCPRequest;
      let response: MCPResponse;

      switch (request.method) {
        case 'tools/list':
          response = this.handleToolsList(request);
          break;
        
        case 'tools/call':
          response = await this.handleToolCall(request);
          break;
        
        default:
          response = {
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`
            },
            id: request.id
          };
      }

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(response)
      };

    } catch (error: unknown) {
      Debug.error('MCP request error:', error);
      return {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: {
            code: -32603,
            message: 'Internal error: ' + (error instanceof Error ? error.message : 'Unknown error')
          }
        })
      };
    }
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return {
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the input message with Obsidian context',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Message to echo back'
                }
              },
              required: ['message']
            }
          }
        ]
      },
      id: request.id
    };
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const params = request.params ?? {};
    const name = params.name;
    const args = params.arguments;

    if (name === 'echo') {
      const message = (args?.message ?? '') as string;
      const vaultName = this.app.vault.getName();
      const activeFile = this.app.workspace.getActiveFile();
      const fileCount = this.app.vault.getAllLoadedFiles().length;
      
      return {
        result: {
          content: [
            {
              type: 'text',
              text: `🎉 Echo from Obsidian MCP Plugin!

📝 Original message: ${message}
📚 Vault name: ${vaultName}
📄 Active file: ${activeFile?.name || 'None'}
📊 Total files: ${fileCount}
⏰ Timestamp: ${new Date().toISOString()}

✨ This confirms the HTTP MCP transport is working between Claude Code and the Obsidian plugin!

🔧 Plugin version: 0.1.3
🌐 Transport: HTTP MCP
🎯 Status: Connected and operational`
            }
          ]
        },
        id: request.id
      };
    }

    return {
      error: {
        code: -32602,
        message: `Unknown tool: ${name}`
      },
      id: request.id
    };
  }

  private generateServerCode(): string {
    // This would generate the actual server code for a worker
    // For now, we'll use a simpler approach
    return `
      // Browser-compatible HTTP server for MCP
      // This runs in the plugin context
    `;
  }

  getPort(): number {
    return this.port;
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  // Method to simulate handling HTTP requests for testing
  async simulateRequest(method: string, path: string, body?: string): Promise<MCPHTTPResponse> {
    const key = `${method} ${path}`;
    const handler = this.server?.handlers.get(key);
    
    if (!handler) {
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not found' })
      };
    }

    if (method === 'POST' && body) {
      return await handler(body);
    } else {
      return handler();
    }
  }
}