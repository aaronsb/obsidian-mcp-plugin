#!/usr/bin/env node
// Set the plugin description in package.json (the single source of truth).
// Run via `make set-description DESC='...'`, which then runs sync-version.mjs
// to propagate it into manifest.json. Avoids hand-editing either JSON file.

import { readFileSync, writeFileSync } from 'fs';

const desc = process.argv[2];

if (!desc || !desc.trim()) {
  console.error("❌ No description given. Usage: make set-description DESC='Your text.'");
  process.exit(1);
}

// Obsidian's plugin guidelines cap the catalog description at 250 chars.
if (desc.length > 250) {
  console.error(`❌ Description is ${desc.length} chars; Obsidian's limit is 250.`);
  process.exit(1);
}

try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  if (pkg.description === desc) {
    console.log('ℹ️  Description unchanged.');
    process.exit(0);
  }
  pkg.description = desc;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✅ package.json description set (${desc.length} chars). Run sync-version to propagate.`);
} catch (error) {
  console.error('❌ Failed to set description:', error.message);
  process.exit(1);
}
