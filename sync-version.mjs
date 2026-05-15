#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

try {
  // Read version from package.json
  const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));
  const version = packageJson.version;

  // Read and update manifest.json
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
  manifest.version = version;

  // Write updated manifest.json
  writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  // Read and update mcpb/manifest.json (MCPB bundle for Claude Desktop)
  const mcpbManifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf-8'));
  mcpbManifest.version = version;
  writeFileSync('mcpb/manifest.json', JSON.stringify(mcpbManifest, null, 2) + '\n');

  // Update version.ts
  const versionTs = `// Version is injected at build time by sync-version.mjs
export function getVersion(): string {
  return '${version}';
}
`;
  writeFileSync('src/version.ts', versionTs);

  console.log(`✅ Synced version ${version} to manifest.json, mcpb/manifest.json, and version.ts`);
} catch (error) {
  console.error('❌ Failed to sync version:', error.message);
  process.exit(1);
}