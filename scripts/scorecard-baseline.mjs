#!/usr/bin/env node
// Regenerate scripts/scorecard-baseline.json from the live portal (#165).
//
// This is a DELIBERATE act: run it only when the scorecard genuinely
// changed in an ACCEPTED way (e.g. a finding cleared by a shipped fix, or
// a new finding analysed and accepted), then commit the new baseline. The
// scorecard-watch workflow fails against whatever this file records, so an
// accidental re-baseline silently disarms the gate — hence a separate,
// named command, not an automatic refresh.
//
// Refuses to write on scraper drift (the live read is untrustworthy then).

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const run = spawnSync(process.execPath, ['scripts/scorecard.mjs', '--json'], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
const jsonLine = (run.stdout || '')
  .split('\n')
  .reverse()
  .find((l) => l.trim().startsWith('{'));
if (!jsonLine) {
  console.error('scorecard-baseline: portal unreachable / no JSON — not writing.');
  process.exit(1);
}
const j = JSON.parse(jsonLine);
if (j.integrity === 'DRIFT' || run.status === 2) {
  console.error(
    'scorecard-baseline: SCRAPER DRIFT — refusing to baseline an untrustworthy read. Fix scripts/scorecard.mjs first.',
  );
  process.exit(3);
}
// The gate tolerates a STALE portal (reading an old scan is harmless when
// comparing). Anchoring the baseline to one is not: it would freeze an
// outdated truth and silently mis-calibrate every future gate run until
// the next re-baseline. Refuse — re-baseline only against a portal that
// has actually scanned the version in manifest.json.
if (typeof j.freshness === 'string' && j.freshness.startsWith('STALE')) {
  console.error(
    `scorecard-baseline: portal is STALE (${j.freshness}). Refusing — re-baseline only after the dev portal has re-scanned the current release.`,
  );
  process.exit(4);
}

const baseline = {
  note: 'Regenerate intentionally via `make scorecard-baseline` after an ACCEPTED scorecard change. scripts/scorecard-gate.mjs fails on regressions vs this snapshot.',
  capturedFor: j.portal.currentVersion,
  capturedAt: new Date().toISOString().slice(0, 10),
  health: j.portal.health,
  healthScore: j.portal.healthScore,
  review: j.portal.review,
  reviewScore: j.portal.reviewScore,
  issuesFound: Number(j.portal.issuesFound),
  findings: j.findings.slice().sort(),
};
writeFileSync(
  'scripts/scorecard-baseline.json',
  JSON.stringify(baseline, null, 2) + '\n',
);
console.log(
  `scorecard-baseline: wrote baseline for ${baseline.capturedFor} — Health ${baseline.health} ${baseline.healthScore} | Review ${baseline.review} ${baseline.reviewScore} | ${baseline.issuesFound} issues | ${baseline.findings.length} findings.\nReview the diff and commit scripts/scorecard-baseline.json.`,
);
