import { readFileSync } from 'fs';
import { join } from 'path';
import { MCP_LISTEN_HOST } from '../src/mcp-server';

describe('MCP listen host', () => {
  test('HTTP server uses an explicit loopback listen host', () => {
    expect(MCP_LISTEN_HOST).toBe('127.0.0.1');

    const source = readFileSync(join(__dirname, '../src/mcp-server.ts'), 'utf8');
    expect(source).toContain('this.server.listen(this.port, MCP_LISTEN_HOST,');
  });

  test('Node MCP server binds to loopback only', async () => {
    jest.resetModules();

    const fakeServer: {
      listen: jest.Mock;
      on: jest.Mock;
      close: jest.Mock;
    } = {
      listen: jest.fn((_port: number, _host: string, callback: () => void) => {
        callback();
        return fakeServer;
      }),
      on: jest.fn(() => fakeServer),
      close: jest.fn((callback: () => void) => {
        callback();
        return fakeServer;
      })
    };

    const createServer = jest.fn(() => fakeServer);
    jest.doMock('http', () => ({ createServer }));

    const { NodeMCPServer, NODE_MCP_LISTEN_HOST } = await import('../src/node-mcp-server');
    const server = new NodeMCPServer({} as never, 4567);

    await server.start();

    expect(NODE_MCP_LISTEN_HOST).toBe('127.0.0.1');
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(fakeServer.listen).toHaveBeenCalledWith(4567, NODE_MCP_LISTEN_HOST, expect.any(Function));

    await server.stop();
  });
});
