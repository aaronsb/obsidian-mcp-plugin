import { Debug } from './utils/debug';
import { App } from 'obsidian';

interface MCPRequest {
  method: string;
  params?: any;
  id?: string | number;
}

interface MCPResponse {
  result?: any;
  error?: {
    code: number;
    message: string;
  };
  id?: string | number;
}

export class NodeMCPServer {
  private app: App;
  private port: number;
  private server: any;
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
      // Try to use Node.js HTTP server if available in Obsidian
      const http = require('http');
      
      this.server = http.createServer((req: any, res: any) => {
        this.handleRequest(req, res);
      });

      await new Promise<void>((resolve, reject) => {
        this.server.listen(this.port, () => {
          this.isRunning = true;
          Debug.log(`🚀 MCP server started on port ${this.port}`);
          Debug.log(`📍 Health check: /`);
          Debug.log(`🔗 MCP endpoint: /mcp`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          Debug.error('❌ Failed to start MCP server:', error);
          reject(error);
        });
      });

    } catch (error) {
      Debug.error('❌ Node.js HTTP not available, server cannot start:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        this.server = undefined;
        Debug.log('👋 MCP server stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && req.url === '/') {
        await this.handleHealthCheck(req, res);
      } else if (req.method === 'POST' && req.url === '/mcp') {
        await this.handleMCPRequest(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      Debug.error('Request handling error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }

  private async handleHealthCheck(req: any, res: any): Promise<void> {
    const response = {
      name: 'Semantic Notes Vault MCP',
      version: '0.1.4',
      status: 'running',
      vault: this.app.vault.getName(),
      timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async handleMCPRequest(req: any, res: any): Promise<void> {
    let body = '';
    
    req.on('data', (chunk: any) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const request: MCPRequest = JSON.parse(body);
        let response: MCPResponse;

        Debug.log('📨 MCP Request:', request.method, request.params);

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

        Debug.log('📤 MCP Response:', response);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));

      } catch (error) {
        Debug.error('MCP request parsing error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: -32700,
            message: 'Parse error: ' + (error instanceof Error ? error.message : 'Invalid JSON')
          }
        }));
      }
    });
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
    const { name, arguments: args } = request.params || {};

    if (name === 'echo') {
      const message = args?.message as string;
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

🔧 Plugin version: 0.1.4
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

  getPort(): number {
    return this.port;
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }
}