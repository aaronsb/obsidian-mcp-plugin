/**
 * Characterization corpus for the ADR-201 sandboxed-evaluator work (#180).
 *
 * PR1 (this file): lock the *current* `new Function` evaluator's behaviour
 * over the differential corpus, and prove the live RCE the ADR exists to
 * close — `constructor.constructor` reaches the `Function` constructor through
 * the `with` scope chain, so a synced/shared `.base` runs arbitrary JS today.
 *
 * PR2 swaps in the vetted no-eval library: the EVAL_CASES block must keep
 * passing unchanged (proving behavioural parity), and the SECURITY block here
 * gets *inverted* — every escape must then throw or return the evaluator's
 * safe `false`, never a computed value.
 */

import { App } from 'obsidian';
import { ExpressionEvaluator } from '../src/utils/expression-evaluator';
import {
  EVAL_CASES,
  SECURITY_EXPRESSIONS,
  makeNoteContext,
} from './fixtures/base-corpus';

const evaluator = new ExpressionEvaluator(new App());

describe('ExpressionEvaluator — behavioural baseline (current new Function, ADR-201/#180)', () => {
  for (const { expr, expected } of EVAL_CASES) {
    it(`evaluates: ${expr}`, () => {
      expect(evaluator.evaluate(expr, makeNoteContext())).toEqual(expected);
    });
  }
});

describe('ExpressionEvaluator — live RCE the new Function path exposes (ADR-201 motivation)', () => {
  // These assertions are intentionally the *vulnerability*: a computed return
  // value proves arbitrary JS executed. PR2 inverts each to expect a thrown
  // error or the evaluator's safe `false` — never the number below.
  const proofs: { expr: string; reachedValue: number }[] = [
    { expr: 'constructor.constructor("return 1 + 1")()', reachedValue: 2 },
    { expr: '({}).constructor.constructor("return 42")()', reachedValue: 42 },
    { expr: '(1).constructor.constructor("return 99")()', reachedValue: 99 },
  ];

  for (const { expr, reachedValue } of proofs) {
    it(`TODAY executes arbitrary code via: ${expr}`, () => {
      expect(evaluator.evaluate(expr, makeNoteContext())).toBe(reachedValue);
    });
  }

  it('every SECURITY_EXPRESSIONS entry is a defined escape vector to invert in PR2', () => {
    // No behavioural assertion here (some escapes return huge globals); this
    // pins the set's existence so PR2 has an explicit inversion checklist.
    expect(SECURITY_EXPRESSIONS.length).toBeGreaterThanOrEqual(10);
    expect(SECURITY_EXPRESSIONS).toContain('globalThis');
    expect(SECURITY_EXPRESSIONS).toContain(
      'constructor.constructor("return 1 + 1")()',
    );
  });
});
