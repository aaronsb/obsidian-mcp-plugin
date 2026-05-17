#!/usr/bin/env node
// Fetch the Obsidian community portal scorecard for this plugin and surface it
// as diffable prose plus a freshness delta against local repo state.
//
// Why: the portal page is public and server-rendered, so the automated
// Health/Review scan is free signal we can pull without logging in. But a
// *fresh* scan is only triggered from the (authenticated) developer portal —
// so the public scorecard reflects whatever release Obsidian last scanned,
// not necessarily our HEAD. This script makes that staleness explicit by
// diffing the portal's reported version/updated against the local repo.
//
// Usage: node scripts/scorecard.mjs            (prose, for reading/evaluation)
//        node scripts/scorecard.mjs --json     (single JSON line, for diffing)
//
// Exit code is always 0 — this is an advisory signal, not a gate.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SLUG = 'semantic-vault-mcp';
const URL = `https://community.obsidian.md/plugins/${SLUG}`;

// The portal is a Next.js App Router page. After Obsidian's 2026 redesign
// (#183) the scorecard is a card UI: Health/Review render as a coloured
// grade word plus a segmented bar meter (filled vs `bg-gray-*` segments —
// that ratio is the portal's numeric trust score now), and the detailed
// findings live in the RSC flight payload as JSX tuples
// `["$","div","<finding text>",{...}]`. We unescape the document (unicode +
// backslash escapes) but keep tags, because the bar meter is structural
// (class names), not text. A separate tag-stripped view serves the prose
// fields. This coupling to their serialization is why the drift guard exists.
function decodeDoc(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

function toText(decoded) {
  return decoded
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function pick(re, text, group = 1) {
  const m = text.match(re);
  return m ? m[group].trim() : null;
}

// Health/Review: the grade word is the coloured <span> right after the
// label span; the score is the fill ratio of the segmented bar meter that
// immediately follows. Bound the window to the next known label so Health's
// meter cannot bleed into Review's. Grade vocab is NOT enum-pinned — the old
// hard-coded list (Excellent|Good|…) is exactly what drifted; capture
// whatever word the portal renders and let the drift guard catch a null.
function gradeAndScore(decoded, label, endLabel) {
  const tag = `>${label}</span>`;
  const start = decoded.indexOf(tag);
  if (start === -1) return { grade: null, score: null };
  const grade = pick(
    new RegExp(`>${label}</span><span[^>]*>([^<]+)</span>`),
    decoded,
  );
  const end = endLabel ? decoded.indexOf(`>${endLabel}</span>`, start) : -1;
  const window = decoded.slice(start, end > start ? end : start + 500);
  const bars = [
    ...window.matchAll(/h-1\.5 flex-1 rounded-full bg-([a-z]+)-\d+/g),
  ].map((m) => m[1]);
  const filled = bars.filter((c) => c !== 'gray').length;
  return { grade, score: bars.length ? `${filled}/${bars.length}` : null };
}

function repoState() {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const git = (cmd) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return null;
    }
  };
  return {
    manifestVersion: manifest.version,
    latestTag: git('git describe --tags --abbrev=0'),
    headSha: git('git rev-parse --short HEAD'),
    headDate: git('git log -1 --format=%cI'),
  };
}

async function main() {
  const asJson = process.argv.includes('--json');

  let html;
  try {
    const res = await fetch(URL, { headers: { 'User-Agent': 'obsidian-mcp-scorecard/1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.error(`scorecard: could not fetch ${URL} — ${e.message}`);
    process.exit(0);
  }

  const decoded = decodeDoc(html);
  const text = toText(decoded);

  const health = gradeAndScore(decoded, 'Health', 'Review');
  const review = gradeAndScore(decoded, 'Review', 'About');

  const portal = {
    health: health.grade,
    healthScore: health.score,
    review: review.grade,
    reviewScore: review.score,
    issuesFound: pick(/(\d+)\s+issues? found by automated scans/i, text),
    currentVersion: pick(/Current version\s+([0-9][^\s]*)/i, text),
    lastUpdated: pick(/Last updated\s+(.+?)\s+Created/i, text),
    created: pick(/Created\s+(.+?)\s+(?:Updates|Downloads)/i, text),
  };

  // Findings live in the RSC flight payload as JSX tuples
  // ["$","div"|"details","<finding text>",{"className":...}] within the
  // scorecard region (anchored to the "issues found by automated scans"
  // sentence). The SIGNATURE — re-anchored to the redesign's wording: bold
  // "**Title**:" entries plus the neutral scan/attestation sentences — is
  // the contract. Reworded findings trip the drift guard below rather than
  // silently dropping out.
  const a = decoded.indexOf('issues found by automated scans');
  const region = a === -1 ? decoded : decoded.slice(a, a + 40000);
  const SIGNATURE =
    /\*\*[^*]+\*\*:|scan not available|artifact attestation|certificate verification|additional files|verification not available|are supported/i;
  const candidates = [
    ...new Set(
      [
        ...region.matchAll(
          /\["\$","(?:div|details|summary)","((?:[^"\\]|\\.){12,500})",\{"className"/g,
        ),
      ]
        .map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim())
        .filter((s) => SIGNATURE.test(s)),
    ),
  ];
  // Drop fragments that are a substring of a longer kept finding — the
  // payload carries both whole sentences and partial JSX children.
  const findings = candidates
    .filter((s) => !candidates.some((o) => o !== s && o.includes(s)))
    .slice(0, 20);

  // Scraper drift guard. This parser depends on the portal's current
  // structure (grade spans, the segmented-bar meter, the RSC finding
  // tuples). When Obsidian reworks the page, anchors silently vanish and
  // fields return null — which would look like a clean scorecard. Treat
  // missing critical anchors as a hard failure that tells the operator to
  // review THIS script, not as a passing scan. The numeric scores are
  // first-class anchors now (#183): losing the meter silently is exactly
  // the drift we guard against.
  const critical = {
    health: portal.health,
    'health score': portal.healthScore,
    review: portal.review,
    'review score': portal.reviewScore,
    'issues count': portal.issuesFound,
    'portal version': portal.currentVersion,
  };
  const missing = Object.entries(critical)
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  // A non-zero automated-issue count with zero extracted findings means the
  // finding selectors drifted even if the headline anchors still parse.
  const findingsDrift =
    Number(portal.issuesFound) > 0 && findings.length === 0;
  const drift = missing.length > 0 || findingsDrift;

  const repo = repoState();

  // Freshness: is the public scorecard even reviewing our current version?
  let freshness = 'unknown';
  if (portal.currentVersion && repo.manifestVersion) {
    if (portal.currentVersion === repo.manifestVersion) {
      freshness = 'current — portal scanned the version in manifest.json';
    } else {
      freshness = `STALE — portal scanned ${portal.currentVersion}, manifest is ${repo.manifestVersion} (a logged-in re-scan on the dev portal is needed to refresh)`;
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify({
        portal,
        findings,
        repo,
        freshness,
        integrity: drift ? 'DRIFT' : 'ok',
        missingAnchors: missing,
        findingsDrift,
        fetchedAt: new Date().toISOString(),
      }),
    );
    process.exit(drift ? 2 : 0);
  }

  if (drift) {
    const bang = '!'.repeat(64);
    console.error(bang);
    console.error('SCRAPER DRIFT — the Obsidian portal page no longer parses');
    console.error('as expected. Do NOT trust the scorecard below; it may be');
    console.error('silently empty. scripts/scorecard.mjs needs review.');
    if (missing.length) console.error(`  missing anchors : ${missing.join(', ')}`);
    if (findingsDrift) console.error('  findings selectors matched nothing despite a non-clean Review');
    console.error(`  page          : ${URL}`);
    console.error(bang);
  }

  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Obsidian scorecard — ${SLUG}`);
  console.log(URL);
  console.log(line);
  console.log(`Health          : ${portal.health ?? '?'} ${portal.healthScore ? `(${portal.healthScore})` : ''}`.trimEnd());
  console.log(`Review          : ${portal.review ?? '?'} ${portal.reviewScore ? `(${portal.reviewScore})` : ''}  (${portal.issuesFound ?? '?'} issues)`);
  console.log(`Portal version  : ${portal.currentVersion ?? '?'}`);
  console.log(`Portal updated  : ${portal.lastUpdated ?? '?'}`);
  console.log(`Portal created  : ${portal.created ?? '?'}`);
  console.log(line);
  console.log(`Repo manifest   : ${repo.manifestVersion}`);
  console.log(`Repo latest tag : ${repo.latestTag ?? '?'}`);
  console.log(`Repo HEAD       : ${repo.headSha ?? '?'} (${repo.headDate ?? '?'})`);
  console.log(line);
  console.log(`Freshness       : ${freshness}`);
  console.log(line);
  console.log('Findings (prose — read, do not gate on):');
  for (const f of findings) console.log(`  • ${f}`);
  console.log(line);

  // Non-zero only on scraper drift — the scorecard content itself is
  // advisory and never gates, but a broken parser must be loud.
  process.exit(drift ? 2 : 0);
}

main();
