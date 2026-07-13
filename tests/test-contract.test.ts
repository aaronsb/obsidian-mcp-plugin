/**
 * The test contract — rules the test suite itself must satisfy.
 *
 * A test suite is only worth its green checkmark if a passing run actually means the
 * code works. Every rule below closes a way a suite can be green while proving nothing.
 * This file is the enforcement; it lints the corpus the way ESLint lints src/.
 *
 * (Source-grep guards are an established pattern here — see tls-cert-verification.test.ts.
 * This avoids adding eslint-plugin-jest, which the CLAUDE.md supply-chain hold would
 * otherwise delay by 7 days.)
 *
 * Rules:
 *  1. No focused tests   — `.only` greens a run while silently skipping everything else.
 *  2. No skipped tests   — a skip is an assertion you have stopped making. Known bugs
 *                          use `it.failing`, which fails if the bug is ever fixed and
 *                          therefore self-corrects; a `.skip` rots silently forever.
 *  3. Every file asserts — a test with no expect() passes by merely not throwing.
 *  4. No lone expect(true).toBe(true) style tautologies.
 *  5. Coverage floors exist — the ratchet in jest.config.js must not be deleted.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = join(__dirname);

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return testFiles(full);
    return full.endsWith('.test.ts') ? [full] : [];
  });
}

const FILES = testFiles(TESTS_DIR).map(path => ({
  path,
  rel: path.replace(join(__dirname, '..') + '/', ''),
  // Strip block and line comments so prose about `.only` (like this file's own header)
  // is not mistaken for the real thing.
  source: readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}));

describe('test contract', () => {
  it('should have found the test corpus', () => {
    // Guards the guard: if the walker breaks, every rule below would vacuously pass.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('should contain no focused tests', () => {
    const offenders = FILES
      .filter(f => /\b(?:it|test|describe)\.only\b|\bfit\(|\bfdescribe\(/.test(f.source))
      .map(f => f.rel);

    expect(offenders).toEqual([]);
  });

  it('should contain no skipped tests', () => {
    const offenders = FILES
      .filter(f => /\b(?:it|test|describe)\.skip\b|\bxit\(|\bxdescribe\(/.test(f.source))
      .map(f => f.rel);

    expect(offenders).toEqual([]);
  });

  it('should assert something in every test file', () => {
    const offenders = FILES
      .filter(f => !/\bexpect\(/.test(f.source))
      .map(f => f.rel);

    expect(offenders).toEqual([]);
  });

  it('should contain no tautological assertions', () => {
    const offenders = FILES
      .filter(f => /expect\(\s*(true|false|1)\s*\)\s*\.\s*toBe\(\s*(true|false|1)\s*\)/.test(f.source))
      .map(f => f.rel);

    expect(offenders).toEqual([]);
  });
});

describe('coverage ratchet', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.config.js is CJS
  const config = require('../jest.config.js');

  it('should define coverage thresholds', () => {
    expect(config.coverageThreshold).toBeDefined();
  });

  it('should hold the security boundary to a higher floor than the global one', () => {
    const security = config.coverageThreshold['./src/security/'];
    const global = config.coverageThreshold.global;

    expect(security.statements).toBeGreaterThan(global.statements);
    expect(security.branches).toBeGreaterThan(global.branches);
  });

  it('should keep every floor above zero', () => {
    const floors = Object.values(config.coverageThreshold) as Record<string, number>[];

    expect(floors.length).toBeGreaterThan(0);
    for (const floor of floors) {
      for (const value of Object.values(floor)) {
        expect(value).toBeGreaterThan(0);
      }
    }
  });
});
