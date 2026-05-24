import { readFileSync } from 'fs';
import { join } from 'path';
import {
  classifyFromSettings,
  agentInstructionsForVerdict,
  resolveListenHost
} from '../src/utils/network-classifier';

describe('ADR-107 integration', () => {
  test('mcp-server.ts passes resolveListenHost result to listen()', () => {
    const src = readFileSync(join(__dirname, '../src/mcp-server.ts'), 'utf8');
    expect(src).toContain("resolveListenHost(bindMode, customHost)");
    expect(src).toContain('this.server.listen(this.port, this.resolvedListenHost,');
  });

  test('mcp-server.ts pushes verdict-derived instructions to the server pool', () => {
    const src = readFileSync(join(__dirname, '../src/mcp-server.ts'), 'utf8');
    expect(src).toContain('this.mcpServerPool.setInitializeInstructions(');
    expect(src).toContain('agentInstructionsForVerdict(this.currentVerdict');
  });

  test('mcp-server.ts fires a Notice and Debug.error on the jail verdict', () => {
    const src = readFileSync(join(__dirname, '../src/mcp-server.ts'), 'utf8');
    expect(src).toMatch(/verdict\.class\s*===\s*'jail'/);
    expect(src).toContain('Debug.error');
    expect(src).toContain('new Notice(');
  });

  test('mcp-server-pool.ts conditionally injects instructions into Server options', () => {
    const src = readFileSync(join(__dirname, '../src/utils/mcp-server-pool.ts'), 'utf8');
    expect(src).toContain('setInitializeInstructions(');
    expect(src).toContain('this.initializeInstructions');
    expect(src).toMatch(/\.\.\.\(this\.initializeInstructions \? \{ instructions: this\.initializeInstructions \} : \{\}\)/);
  });

  test('node-mcp-server.ts hardcodes loopback (ADR-107 default for unwired fallback)', () => {
    const src = readFileSync(join(__dirname, '../src/node-mcp-server.ts'), 'utf8');
    expect(src).toContain("const host = '127.0.0.1'");
    expect(src).toContain('this.server!.listen(this.port, host,');
  });

  test('verdict→instructions pipeline yields warning text for jail and null elsewhere', () => {
    const jail = classifyFromSettings({
      httpsEnabled: false,
      bindMode: 'all',
      customBindHost: '',
      userSuppliedCert: false
    });
    const ok = classifyFromSettings({
      httpsEnabled: false,
      bindMode: 'loopback',
      customBindHost: '',
      userSuppliedCert: false
    });
    const warn = classifyFromSettings({
      httpsEnabled: true,
      bindMode: 'all',
      customBindHost: '',
      userSuppliedCert: false
    });

    expect(agentInstructionsForVerdict(jail, '0.0.0.0', 3001)).toContain('SECURITY WARNING');
    expect(agentInstructionsForVerdict(ok, '127.0.0.1', 3001)).toBeNull();
    expect(agentInstructionsForVerdict(warn, '0.0.0.0', 3443)).toBeNull();
  });

  test('default install state resolves to ok verdict and 127.0.0.1 host', () => {
    const host = resolveListenHost('loopback', '');
    const v = classifyFromSettings({
      httpsEnabled: false,
      bindMode: 'loopback',
      customBindHost: '',
      userSuppliedCert: false
    });
    expect(host).toBe('127.0.0.1');
    expect(v.class).toBe('ok');
  });
});
