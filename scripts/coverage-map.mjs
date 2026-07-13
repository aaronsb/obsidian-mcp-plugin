#!/usr/bin/env node
/**
 * Coverage map — turns coverage/coverage-summary.json into something actionable.
 *
 * A single global percentage tells you nothing about *where* to spend the next test.
 * This ranks files two ways:
 *   1. Risk tier — security/boundary code first, because a coverage hole there leaks
 *      vault content rather than merely breaking a call.
 *   2. Absolute gap — uncovered statements, so effort goes where it moves the number.
 *
 * Run `make coverage` first (this reads the summary it writes).
 * `--json` emits one machine-readable line for diffing across releases.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SUMMARY = resolve('coverage/coverage-summary.json');

// Tiers are ordered: the first matching pattern wins.
const TIERS = [
  { name: 'security boundary', re: /^src\/(security|validation)\// },
  { name: 'core api + routing', re: /^src\/(semantic|utils\/obsidian-api|tools|mcp-server)/ },
  { name: 'supporting', re: /.*/ }
];

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
} catch {
  console.error(`No coverage summary at ${SUMMARY}.\nRun \`make coverage\` first.`);
  process.exit(2);
}

const cwd = process.cwd() + '/';
const files = Object.entries(summary)
  .filter(([f]) => f !== 'total')
  .map(([f, m]) => {
    const file = f.replace(cwd, '');
    return {
      file,
      tier: TIERS.find(t => t.re.test(file)).name,
      pct: m.statements.pct,
      covered: m.statements.covered,
      total: m.statements.total,
      gap: m.statements.total - m.statements.covered
    };
  });

const total = summary.total;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    total: {
      statements: total.statements.pct,
      branches: total.branches.pct,
      functions: total.functions.pct,
      lines: total.lines.pct
    },
    files: files.map(({ file, tier, pct, gap }) => ({ file, tier, pct, gap }))
  }));
  process.exit(0);
}

const bar = pct => {
  const filled = Math.round(pct / 5);
  return '█'.repeat(filled) + '·'.repeat(20 - filled);
};

console.log('\nCOVERAGE MAP\n');
console.log(
  `  overall  statements ${total.statements.pct}%   branches ${total.branches.pct}%   ` +
  `functions ${total.functions.pct}%   lines ${total.lines.pct}%\n`
);

for (const { name } of TIERS) {
  const tierFiles = files.filter(f => f.tier === name).sort((a, b) => a.pct - b.pct);
  if (!tierFiles.length) continue;

  const covered = tierFiles.reduce((n, f) => n + f.covered, 0);
  const stmts = tierFiles.reduce((n, f) => n + f.total, 0);
  const tierPct = stmts ? (100 * covered / stmts).toFixed(1) : '100.0';

  console.log(`  ${name.toUpperCase()} — ${tierPct}% of ${stmts} statements`);
  for (const f of tierFiles) {
    const pct = String(f.pct.toFixed(1)).padStart(5);
    console.log(`    ${bar(f.pct)} ${pct}%  ${String(f.gap).padStart(4)} uncov  ${f.file}`);
  }
  console.log();
}

console.log('  BIGGEST GAPS (uncovered statements)');
for (const f of [...files].sort((a, b) => b.gap - a.gap).slice(0, 10)) {
  console.log(`    ${String(f.gap).padStart(4)}  ${String(f.pct.toFixed(1)).padStart(5)}%  ${f.file}`);
}
console.log('\n  Floors live in jest.config.js (coverageThreshold). `make coverage-gate` enforces them.\n');
