#!/usr/bin/env node
// Pack mcpb/ into obsidian-mcp-<version>.mcpb using a stored-only zip
// container. Pure Node, no deps — works on any Node ≥18.

import { readFileSync, writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    chunks.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, ...central, eocd]);
}

export function buildMcpb({ manifest, serverJs }) {
  return zipStore([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    { name: 'server.js', data: Buffer.from(serverJs, 'utf8') },
  ]);
}

// CLI: emit both a versioned bundle (for archival) and an unversioned
// alias so the Settings UI / README can link to a stable
// releases/latest/download/obsidian-mcp.mcpb URL regardless of plugin
// version.
if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf-8'));
  const serverJs = readFileSync('mcpb/server.js', 'utf-8');
  const bytes = buildMcpb({ manifest, serverJs });
  const versioned = `obsidian-mcp-${manifest.version}.mcpb`;
  const latest = 'obsidian-mcp.mcpb';
  writeFileSync(versioned, bytes);
  writeFileSync(latest, bytes);
  console.log(`✅ Built ${versioned} and ${latest} (${manifest.version})`);
}
