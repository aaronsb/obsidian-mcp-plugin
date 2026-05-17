#!/usr/bin/env node
// Post-release regression gate over the Obsidian portal scorecard (#165).
//
// Runs `scorecard.mjs --json`, diffs the structured signals against the
// committed baseline (scripts/scorecard-baseline.json), and FAILS the
// workflow only on a genuine regression:
//
//   - Health or Review score ratio dropped vs baseline   (a downgrade)
//   - automated issue count increased vs baseline
//   - a new permission/behaviour finding appeared          (a "**Title**:"
//     entry absent from the baseline)
//
// It never inspects advisory *wording* — only structured deltas — so a
// reworded-but-equivalent finding does not fail the gate (that is the
// scraper drift guard's job, handled distinctly below).
//
// Exit codes:
//   0  no regression (or inconclusive: portal unreachable — never a false fail)
//   1  regression vs baseline  → fail the workflow (intended signal)
//   3  scraper drift           → distinct: fix scorecard.mjs, NOT a portal change
//
// This is a standalone scheduled job. It does not run on PRs or releases
// and gates nothing in the release path — it only turns a silent portal
// regression into a visible red check.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASELINE = 'scripts/scorecard-baseline.json';

// "filled/total" → ratio in [0,1], or null if unparseable / total 0.
function ratio(score) {
  if (typeof score !== 'string') return null;
  const m = score.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const total = Number(m[2]);
  return total > 0 ? Number(m[1]) / total : null;
}

// The behaviour/permission findings are the bold-titled ones
// ("**Direct Filesystem Access**: …"). Neutral sentences ("… scan not
// available.", "… attestation.") are not regressions when they appear.
const titled = (findings) =>
  new Set(
    (findings || [])
      .map((f) => (f.match(/^\*\*([^*]+)\*\*:/) || [])[1])
      .filter(Boolean),
  );

function main() {
  const run = spawnSync(process.execPath, ['scripts/scorecard.mjs', '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  const jsonLine = (run.stdout || '')
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));

  if (!jsonLine) {
    // scorecard.mjs exits 0 and prints to stderr when the portal is
    // unreachable. A transient network failure must never fail the gate.
    console.log(
      'scorecard-gate: portal unreachable / no JSON — inconclusive, not a regression.',
    );
    if (run.stderr) console.log(run.stderr.trim());
    process.exit(0);
  }

  const live = JSON.parse(jsonLine);

  if (live.integrity === 'DRIFT' || run.status === 2) {
    const bang = '!'.repeat(64);
    console.error(bang);
    console.error('SCRAPER DRIFT — the portal parser no longer matches the');
    console.error('page. This is NOT a plugin/portal regression: fix');
    console.error('scripts/scorecard.mjs. Gate is inconclusive.');
    if (live.missingAnchors?.length)
      console.error(`  missing anchors : ${live.missingAnchors.join(', ')}`);
    console.error(bang);
    process.exit(3);
  }

  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const p = live.portal || {};
  const regressions = [];

  for (const [label, liveScore, baseScore] of [
    ['Health', p.healthScore, base.healthScore],
    ['Review', p.reviewScore, base.reviewScore],
  ]) {
    const lr = ratio(liveScore);
    const br = ratio(baseScore);
    if (lr != null && br != null && lr < br) {
      regressions.push(
        `${label} score downgraded: ${baseScore} → ${liveScore}`,
      );
    }
  }

  const liveIssues = Number(p.issuesFound);
  if (Number.isFinite(liveIssues) && liveIssues > Number(base.issuesFound)) {
    regressions.push(
      `automated issue count rose: ${base.issuesFound} → ${liveIssues}`,
    );
  }

  const baseTitled = titled(base.findings);
  const newTitled = [...titled(live.findings)].filter((t) => !baseTitled.has(t));
  if (newTitled.length) {
    regressions.push(`new behaviour/permission finding(s): ${newTitled.join('; ')}`);
  }

  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Scorecard gate — baseline captured for ${base.capturedFor} (${base.capturedAt})`);
  console.log(
    `Live: Health ${p.health} ${p.healthScore} | Review ${p.review} ${p.reviewScore} | ${p.issuesFound} issues | freshness: ${live.freshness}`,
  );
  console.log(line);

  if (typeof live.freshness === 'string' && live.freshness.startsWith('STALE')) {
    // Not a regression and not gating: the portal simply hasn't re-scanned
    // the current release yet. Surface it so a pass/fail is read in context.
    console.log(`note: portal scan is STALE — ${live.freshness}`);
  }

  if (regressions.length) {
    console.error('REGRESSION vs baseline:');
    for (const r of regressions) console.error(`  ✗ ${r}`);
    console.error(line);
    console.error(
      'If this reflects an ACCEPTED change, re-baseline deliberately:\n  make scorecard-baseline   (then commit scripts/scorecard-baseline.json)',
    );
    process.exit(1);
  }

  // Surface improvements for the log (informational, never gating).
  const baseTitledArr = [...baseTitled];
  const liveTitledSet = titled(live.findings);
  const cleared = baseTitledArr.filter((t) => !liveTitledSet.has(t));
  if (cleared.length) console.log(`Improved — finding(s) cleared: ${cleared.join('; ')}`);
  console.log('No regression vs baseline. ✓');
  process.exit(0);
}

main();
