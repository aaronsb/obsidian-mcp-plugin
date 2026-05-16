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

// The portal is a Next.js App Router page. The scorecard *summary*
// (Health/Review/version) is rendered into the DOM, but the detailed
// findings live only in the RSC flight payload inside <script>
// self.__next_f.push(...) </script> as escaped JSON. So we decode the
// whole document — DOM text AND unescaped script payload — into one
// searchable blob. This coupling to their internal serialization is
// exactly why the drift guard below exists.
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
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

  const text = htmlToText(html);

  const portal = {
    health: pick(/Health\s+(Excellent|Good|Fair|Poor|Caution)/i, text),
    review: pick(/Review\s+(Excellent|Good|Caution|Warning|Critical)/i, text),
    issuesFound: pick(/(\d+)\s+issues? found by automated scans/i, text),
    currentVersion: pick(/Current version\s+([0-9][^\s]*)/i, text),
    lastUpdated: pick(/Last updated\s+([^\n]+?)(?:\s+Created)/i, text),
    created: pick(/Created\s+([^\n]+?)(?:\s+Updates|\s+Downloads)/i, text),
  };

  // Findings come through as discrete JSON string literals in the decoded
  // payload, not contiguous prose, so isolate candidate sentences and keep
  // the ones carrying a known finding signature. The signature set — not a
  // DOM path — is the contract; if Obsidian rewords these, the drift guard
  // fires rather than silently dropping findings.
  const SIGNATURE =
    /(scan not available\.|verification not available\.|\)\s*calls|artifact attestation|certificate verification|additional files|are supported\.|issues? found by automated)/i;
  const candidates = [
    ...new Set(
      (text.match(/[^\n"]{12,260}/g) || [])
        .map((s) => s.trim())
        .filter((s) => SIGNATURE.test(s)),
    ),
  ];
  // Drop fragments that are a substring of a longer kept finding — the
  // payload carries both whole sentences and partial JSX children.
  const findings = candidates
    .filter((s) => !candidates.some((o) => o !== s && o.includes(s)))
    .slice(0, 20);

  // Scraper drift guard. This parser depends on the portal's current DOM
  // wording/structure. When Obsidian reworks the page, anchors silently
  // vanish and every field returns null — which would look like a clean
  // scorecard. Treat missing critical anchors as a hard failure that tells
  // the operator to review THIS script, not as a passing scan.
  const critical = {
    health: portal.health,
    review: portal.review,
    'issues count': portal.issuesFound,
    'portal version': portal.currentVersion,
  };
  const missing = Object.entries(critical)
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  // A non-clean Review with zero extracted findings also means the findings
  // selectors drifted, even if the headline anchors still parse.
  const findingsDrift =
    portal.review &&
    /caution|warning|critical/i.test(portal.review) &&
    findings.length === 0;
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
  console.log(`Health          : ${portal.health ?? '?'}`);
  console.log(`Review          : ${portal.review ?? '?'}  (${portal.issuesFound ?? '?'} issues)`);
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
