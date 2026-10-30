/**
 * scripts/scorecard-gate.mjs compares behaviour/permission findings by title (#315).
 *
 * The committed baseline stores findings as `**Title**: description`. The portal
 * now renders the same findings with a `<severity>:<index>:` prefix
 * (`medium:0:**Direct Filesystem Access**: …`), which the raw-string comparison
 * read as every finding cleared, and which hid any genuinely new one. These tests
 * run the real gate script against fixture files through its `--live` /
 * `--baseline` seam, so no network is involved.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GATE = path.resolve(__dirname, '../scripts/scorecard-gate.mjs');

const FS_ACCESS =
  'Uses the Node.js `fs` module to access the filesystem outside of the Obsidian vault API.';
const CLIPBOARD = 'Reads or writes the system clipboard.';
const VAULT_READ = 'Reads individual vault files via the Obsidian API (`vault.read`)';

const baseline = {
  capturedFor: '0.0.1',
  capturedAt: '2026-01-01',
  health: 'Excellent',
  healthScore: '4/4',
  review: 'Satisfactory',
  reviewScore: '3/4',
  issuesFound: 3,
  findings: [
    `**Clipboard Access**: ${CLIPBOARD}`,
    `**Direct Filesystem Access**: ${FS_ACCESS}`,
    `**Vault Read**: ${VAULT_READ}`,
    'Malware scan not available.',
  ],
};

function live(findings: string[]) {
  return {
    portal: {
      health: 'Excellent',
      healthScore: '4/4',
      review: 'Satisfactory',
      reviewScore: '3/4',
      issuesFound: '3',
      currentVersion: '0.0.1',
    },
    findings,
    freshness: 'current — portal scanned the version in manifest.json',
    integrity: 'ok',
    missingAnchors: [],
  };
}

// The same three findings as the baseline, in the portal's current key-prefixed form.
const PREFIXED = [
  `pass:2:**Vault Read**: ${VAULT_READ}`,
  'info:1:Malware scan not available.',
  `medium:0:**Direct Filesystem Access**: ${FS_ACCESS}`,
  `info:2:**Clipboard Access**: ${CLIPBOARD}`,
];

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-gate-'));
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runGate(findings: string[]) {
  const livePath = path.join(dir, `live-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(livePath, JSON.stringify(live(findings)));
  const r = spawnSync(
    process.execPath,
    [GATE, '--baseline', path.join(dir, 'baseline.json'), '--live', livePath],
    { encoding: 'utf8', cwd: path.resolve(__dirname, '..') },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('scorecard-gate finding comparison', () => {
  test('should report no cleared and no new findings when only the portal prefix changed', () => {
    const r = runGate(PREFIXED);
    expect(r.out).not.toMatch(/cleared/);
    expect(r.out).not.toMatch(/REGRESSION/);
    expect(r.status).toBe(0);
  });

  test('should fail with the new title when a prefixed live finding is absent from the baseline', () => {
    const r = runGate([
      ...PREFIXED,
      'medium:1:**Network Access**: Makes network requests outside the Obsidian API.',
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/new behaviour\/permission finding\(s\): Network Access$/m);
  });

  test('should report a finding as cleared only when it is really gone', () => {
    const r = runGate(PREFIXED.filter((f) => !f.includes('Clipboard Access')));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/finding\(s\) cleared: Clipboard Access$/m);
  });
});
