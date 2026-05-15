#!/usr/bin/env node
// Interactive .mcpb maker for advanced users.
// Prompts for name, url, api_key, then emits obsidian-mcp-<name>.mcpb
// using the same pure-Node zip helper as the canonical build.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildMcpb } from './build-mcpb.mjs';

const rl = createInterface({ input: stdin, output: stdout });

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

const ask = async (q, fallback) => {
  const a = (await rl.question(`${q}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return a || fallback || '';
};

try {
  console.log('Obsidian MCPB maker — generates a custom-named bundle for one vault.\n');

  const displayName = await ask('Display name shown in Claude Desktop', 'Obsidian (Work Vault)');
  const slug = slugify(displayName) || 'obsidian-mcp-custom';
  const url = await ask('Obsidian MCP URL', 'http://localhost:3001/mcp');
  const apiKey = await ask('API key (leave blank only if plugin auth is disabled)', '');

  const baseManifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf-8'));
  const serverJs = readFileSync('mcpb/server.js', 'utf-8');

  const manifest = {
    ...baseManifest,
    name: slug,
    display_name: displayName,
    user_config: {
      ...baseManifest.user_config,
      url: { ...baseManifest.user_config.url, default: url },
      api_key: { ...baseManifest.user_config.api_key, default: apiKey },
    },
  };

  const out = `obsidian-mcp-${slug}.mcpb`;
  writeFileSync(out, buildMcpb({ manifest, serverJs }));
  console.log(`\n✅ Built ${out}`);
  console.log(`   Drop it into Claude Desktop to install "${displayName}".`);
  console.log('   The URL and API key are pre-filled — just click Install.');
} finally {
  rl.close();
}
