/**
 * TLS minimum-version negotiation (#252).
 *
 * Behavioural, not source-grep: the server is really started and a real TLS client
 * really handshakes against it. That is what distinguishes "the setting no longer
 * crashes" from "the setting does what it says". The previous implementation used the
 * legacy `secureProtocol` method-string API, which (a) has no TLSv1_3_method, so
 * selecting TLS 1.3 threw at context creation, and (b) PINS one exact version rather
 * than setting a floor — so "minimum TLS 1.2" also silently refused TLS 1.3 clients.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect as tlsConnect } from 'tls';
import { AddressInfo } from 'net';
import { Server as HttpsServer } from 'https';
import { Application } from 'express';
import { App } from 'obsidian';
import { CertificateManager, CertificateConfig } from '../../src/utils/certificate-manager';

const handler = ((_req: unknown, res: { end: (b: string) => void }) => res.end('ok')) as unknown as Application;

let manager: CertificateManager;
let certPath: string;
let keyPath: string;

beforeAll(() => {
  manager = new CertificateManager(new App() as unknown as App);
  const { cert, key } = manager.generateSelfSignedCertificate('localhost');

  const dir = mkdtempSync(join(tmpdir(), 'mcp-tls-'));
  certPath = join(dir, 'cert.pem');
  keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key);
});

function configFor(minTLSVersion: CertificateConfig['minTLSVersion']): CertificateConfig {
  return { enabled: true, certPath, keyPath, minTLSVersion };
}

/** Start the server on an ephemeral port and resolve the port actually bound. */
async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Handshake against the server, resolving the negotiated protocol or an error. */
async function handshake(
  port: number,
  clientOpts: { minVersion?: string; maxVersion?: string } = {}
): Promise<{ ok: true; protocol: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const socket = tlsConnect(
      { port, host: '127.0.0.1', rejectUnauthorized: false, ...clientOpts } as never,
      () => {
        const protocol = socket.getProtocol() ?? 'unknown';
        socket.end();
        resolve({ ok: true, protocol });
      }
    );
    socket.on('error', (err: Error) => resolve({ ok: false, error: err.message }));
  });
}

describe('CertificateManager TLS minimum version (#252)', () => {
  it('should start an HTTPS server when the minimum is TLS 1.3', async () => {
    // Pre-fix this threw "Unknown method: TLSv1_3_method" and the server never bound.
    const server = manager.createServer(handler, configFor('TLSv1.3'), 0) as HttpsServer;
    const port = await listen(server);

    const result = await handshake(port);

    expect(result).toEqual({ ok: true, protocol: 'TLSv1.3' });
    server.close();
  });

  it('should refuse a client capped below the TLS 1.3 minimum', async () => {
    const server = manager.createServer(handler, configFor('TLSv1.3'), 0) as HttpsServer;
    const port = await listen(server);

    const result = await handshake(port, { maxVersion: 'TLSv1.2' });

    expect(result.ok).toBe(false);
    server.close();
  });

  it('should treat TLS 1.2 as a floor, not a pin, and still allow TLS 1.3', async () => {
    // The pre-fix `secureProtocol: 'TLSv1_2_method'` pinned the server to exactly
    // TLS 1.2, so a modern client negotiated 1.2 even though 1.3 was available. The
    // setting is labelled a *minimum*; this asserts it behaves like one.
    const server = manager.createServer(handler, configFor('TLSv1.2'), 0) as HttpsServer;
    const port = await listen(server);

    const result = await handshake(port);

    expect(result).toEqual({ ok: true, protocol: 'TLSv1.3' });
    server.close();
  });

  it('should still accept a TLS 1.2 client when the minimum is TLS 1.2', async () => {
    const server = manager.createServer(handler, configFor('TLSv1.2'), 0) as HttpsServer;
    const port = await listen(server);

    const result = await handshake(port, { maxVersion: 'TLSv1.2' });

    expect(result).toEqual({ ok: true, protocol: 'TLSv1.2' });
    server.close();
  });

  it('should default to a TLS 1.2 floor when no minimum is configured', async () => {
    const server = manager.createServer(handler, { enabled: true, certPath, keyPath }, 0) as HttpsServer;
    const port = await listen(server);

    const result = await handshake(port, { maxVersion: 'TLSv1.1' });

    expect(result.ok).toBe(false);
    server.close();
  });
});
