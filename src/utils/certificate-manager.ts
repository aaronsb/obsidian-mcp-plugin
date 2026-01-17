import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { App, Notice } from 'obsidian';
import { createServer as createHttpServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import { Application } from 'express';
import { Debug } from './debug';
import * as forge from 'node-forge';

export interface CertificateConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  passphrase?: string;
  selfSigned?: boolean;
  autoGenerate?: boolean;
  rejectUnauthorized?: boolean;
  minTLSVersion?: 'TLSv1.2' | 'TLSv1.3';
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  fingerprint: string;
  isValid: boolean;
  isSelfSigned: boolean;
  daysUntilExpiry: number;
}

export class CertificateManager {
  private app: App;
  private certDir: string;
  
  constructor(app: App) {
    this.app = app;
    // Store certificates in plugin data directory
    this.certDir = join(
      (app.vault.adapter as any).basePath,
      app.vault.configDir,
      'plugins',
      'semantic-vault-mcp',
      'certificates'
    );
    this.ensureCertDirectory();
  }
  
  private ensureCertDirectory(): void {
    if (!existsSync(this.certDir)) {
      mkdirSync(this.certDir, { recursive: true });
      Debug.log('📁 Created certificate directory');
    }
  }
  
  /**
   * Generate a self-signed certificate
   */
  public generateSelfSignedCertificate(commonName: string = 'localhost'): { cert: string; key: string } {
    Debug.log('🔐 Generating self-signed certificate...');
    
    // Generate RSA key pair
    const keys = forge.pki.rsa.generateKeyPair(2048);
    
    // Create certificate
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    
    // Set certificate attributes
    const attrs = [{
      name: 'commonName',
      value: commonName
    }, {
      name: 'countryName',
      value: 'US'
    }, {
      shortName: 'ST',
      value: 'State'
    }, {
      name: 'localityName',
      value: 'City'
    }, {
      name: 'organizationName',
      value: 'Obsidian MCP Plugin'
    }, {
      shortName: 'OU',
      value: 'Development'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    
    // Add extensions
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true
    }, {
      name: 'nsCertType',
      client: true,
      server: true,
      email: true,
      objsign: true,
      sslCA: true,
      emailCA: true,
      objCA: true
    }, {
      name: 'subjectAltName',
      altNames: [{
        type: 2, // DNS
        value: 'localhost'
      }, {
        type: 2,
        value: '*.localhost'
      }, {
        type: 7, // IP
        ip: '127.0.0.1'
      }, {
        type: 7,
        ip: '::1'
      }]
    }, {
      name: 'subjectKeyIdentifier'
    }]);
    
    // Sign certificate
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    // Convert to PEM format
    const pemCert = forge.pki.certificateToPem(cert);
    const pemKey = forge.pki.privateKeyToPem(keys.privateKey);
    
    Debug.log('✅ Self-signed certificate generated');
    
    return {
      cert: pemCert,
      key: pemKey
    };
  }
  
  /**
   * Save certificate files
   */
  public saveCertificate(cert: string, key: string, name: string = 'default'): { certPath: string; keyPath: string } {
    const certPath = join(this.certDir, `${name}.crt`);
    const keyPath = join(this.certDir, `${name}.key`);
    
    writeFileSync(certPath, cert, 'utf8');
    writeFileSync(keyPath, key, 'utf8');
    
    Debug.log(`💾 Certificate saved: ${name}`);
    
    return { certPath, keyPath };
  }
  
  /**
   * Load certificate from file
   */
  public loadCertificate(certPath: string, keyPath: string, passphrase?: string): { cert: string; key: string } | null {
    try {
      if (!existsSync(certPath) || !existsSync(keyPath)) {
        Debug.log('❌ Certificate files not found');
        return null;
      }
      
      const cert = readFileSync(certPath, 'utf8');
      const key = readFileSync(keyPath, 'utf8');
      
      // TODO: Handle passphrase-protected keys if needed
      
      Debug.log('✅ Certificate loaded');
      return { cert, key };
    } catch (error) {
      Debug.log('❌ Failed to load certificate:', error);
      return null;
    }
  }
  
  /**
   * Get certificate information
   */
  public getCertificateInfo(certPem: string): CertificateInfo | null {
    try {
      const cert = forge.pki.certificateFromPem(certPem);
      
      const validFrom = cert.validity.notBefore;
      const validTo = cert.validity.notAfter;
      const now = new Date();
      const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      
      const subject = cert.subject.attributes
        .map(attr => {
          const value = Array.isArray(attr.value) ? attr.value.join(',') : String(attr.value ?? '');
          return `${attr.shortName || attr.name}=${value}`;
        })
        .join(', ');

      const issuer = cert.issuer.attributes
        .map(attr => {
          const value = Array.isArray(attr.value) ? attr.value.join(',') : String(attr.value ?? '');
          return `${attr.shortName || attr.name}=${value}`;
        })
        .join(', ');
      
      const fingerprint = forge.md.sha256.create()
        .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
        .digest()
        .toHex();
      
      return {
        subject,
        issuer,
        validFrom,
        validTo,
        fingerprint,
        isValid: now >= validFrom && now <= validTo,
        isSelfSigned: subject === issuer,
        daysUntilExpiry
      };
    } catch (error) {
      Debug.log('❌ Failed to parse certificate:', error);
      return null;
    }
  }
  
  /**
   * Create HTTP or HTTPS server based on configuration
   */
  public createServer(app: Application, config: CertificateConfig, port: number): HttpServer | HttpsServer {
    if (!config.enabled) {
      Debug.log('🔓 Creating HTTP server (SSL/TLS disabled)');
      return createHttpServer(app);
    }
    
    let cert: string | undefined;
    let key: string | undefined;
    let ca: string | undefined;
    
    // Try to load existing certificate
    if (config.certPath && config.keyPath) {
      const loaded = this.loadCertificate(config.certPath, config.keyPath, config.passphrase);
      if (loaded) {
        cert = loaded.cert;
        key = loaded.key;
        
        // Load CA if provided
        if (config.caPath && existsSync(config.caPath)) {
          ca = readFileSync(config.caPath, 'utf8');
        }
      }
    }
    
    // Auto-generate self-signed certificate if needed
    if (!cert || !key) {
      if (config.autoGenerate || config.selfSigned) {
        Debug.log('🔐 Auto-generating self-signed certificate');
        const generated = this.generateSelfSignedCertificate();
        const saved = this.saveCertificate(generated.cert, generated.key);
        
        cert = generated.cert;
        key = generated.key;
        
        // Update config with new paths
        config.certPath = saved.certPath;
        config.keyPath = saved.keyPath;
        
        new Notice('Generated self-signed certificate for HTTPS');
      } else {
        Debug.log('⚠️ No certificate available, falling back to HTTP');
        return createHttpServer(app);
      }
    }
    
    // Create HTTPS server options
    const httpsOptions: any = {
      cert,
      key,
      ca,
      passphrase: config.passphrase,
      rejectUnauthorized: config.rejectUnauthorized !== false,
      secureProtocol: config.minTLSVersion === 'TLSv1.3' ? 'TLSv1_3_method' : 'TLSv1_2_method'
    };
    
    Debug.log('🔒 Creating HTTPS server with certificate');
    
    // Display certificate info
    const info = this.getCertificateInfo(cert);
    if (info) {
      Debug.log(`📜 Certificate: ${info.subject}`);
      Debug.log(`🏛️ Issuer: ${info.issuer}`);
      Debug.log(`📅 Valid until: ${info.validTo.toLocaleDateString()}`);
      if (info.daysUntilExpiry < 30) {
        new Notice(`⚠️ Certificate expires in ${info.daysUntilExpiry} days`);
      }
    }
    
    return createHttpsServer(httpsOptions, app);
  }
  
  /**
   * Get default certificate paths
   */
  public getDefaultPaths(): { certPath: string; keyPath: string } {
    return {
      certPath: join(this.certDir, 'default.crt'),
      keyPath: join(this.certDir, 'default.key')
    };
  }
  
  /**
   * Check if default certificate exists
   */
  public hasDefaultCertificate(): boolean {
    const { certPath, keyPath } = this.getDefaultPaths();
    return existsSync(certPath) && existsSync(keyPath);
  }
}