import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for #163.
 *
 * Obsidian's community scorecard pattern-matches the literal
 * `rejectUnauthorized: false` and flags it as a Risk ("Plugin disables SSL
 * certificate verification"). In our code that option is inert — it is only
 * passed to the inbound HTTPS server, which never sets `requestCert`, so Node
 * ignores it. The fix (#163) was to stop emitting the flagged literal and let
 * certificate-manager default the effective value to `true` via `!== false`.
 *
 * These tests fail if the literal is reintroduced or if the secure default
 * flips, so the finding cannot silently come back.
 */
describe('TLS certificate verification (#163)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('does not emit the scanner-flagged `rejectUnauthorized: false` literal', () => {
    const flagged = /rejectUnauthorized\s*:\s*false/;
    expect(read('src/main.ts')).not.toMatch(flagged);
    expect(read('src/utils/certificate-manager.ts')).not.toMatch(flagged);
  });

  it('keeps certificate-manager defaulting verification ON when unset', () => {
    // The effective option is computed as `config.rejectUnauthorized !== false`.
    // Guard the contract: absent/true => verification on; only an explicit
    // false disables it (and nothing in our defaults sets that).
    const effective = (v: boolean | undefined) => v !== false;
    expect(effective(undefined)).toBe(true);
    expect(effective(true)).toBe(true);
    expect(effective(false)).toBe(false);

    // The expression must still be present in certificate-manager — if it is
    // refactored away, this guard is no longer meaningful and must be revised.
    expect(read('src/utils/certificate-manager.ts')).toMatch(
      /rejectUnauthorized\s*:\s*config\.rejectUnauthorized\s*!==\s*false/,
    );
  });
});
