/**
 * scripts/scorecard.mjs extracts findings without the portal's React key prefix (#315).
 *
 * The portal keys each rendered finding "<severity>:<index>:<text>", and the
 * scraper reads findings from that key. The prefix is rendering metadata, not
 * finding text, so neither the prose report, the --json output nor a future
 * baseline should carry it. Runs the real script on a synthetic saved page
 * through its `--html` seam, so no network is involved.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/scorecard.mjs');
const PAGE = path.join(__dirname, 'fixtures/scorecard-page.html');

const CLEAN = [
  '**Direct Filesystem Access**: Uses the Node.js `fs` module to access the filesystem.',
  '**Clipboard Access**: Reads or writes the system clipboard.',
  'Malware scan not available.',
  '**Vault Read**: Reads individual vault files via the Obsidian API.',
];

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--html', PAGE, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });
}

describe('scorecard finding extraction', () => {
  test('should emit findings without the severity:index key prefix in --json output', () => {
    const r = run('--json');
    const out = JSON.parse(r.stdout.trim());
    expect(out.integrity).toBe('ok');
    expect(out.findings).toEqual(CLEAN);
  });

  test('should print prose findings without the key prefix', () => {
    const r = run();
    expect(r.status).toBe(0);
    for (const f of CLEAN) expect(r.stdout).toContain(`  • ${f}\n`);
    expect(r.stdout).not.toMatch(/•\s+[a-z]+:\d+:/i);
  });
});
