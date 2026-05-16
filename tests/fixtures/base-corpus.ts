/**
 * Representative `.base` YAML corpus + note-frontmatter samples.
 *
 * Used by the js-yaml → yaml migration differential tests (#174) and reusable
 * by the ADR-201 sandboxed-evaluator differential corpus (#180): the filter /
 * formula expression strings here are exactly what that work must evaluate
 * identically.
 */

/** Full `.base` documents exercising the structural shapes bases-api parses. */
export const BASE_DOCS: { name: string; yaml: string }[] = [
  {
    name: 'string filter + single view',
    yaml: [
      'filters: \'status == "active"\'',
      'views:',
      '  - type: table',
      '    name: Active',
    ].join('\n'),
  },
  {
    name: 'nested and/or/not filter + formulas + properties',
    yaml: [
      'filters:',
      '  and:',
      '    - \'file.hasTag("project")\'',
      '    - or:',
      '        - \'priority == "high"\'',
      '        - not:',
      '            - \'status == "done"\'',
      'formulas:',
      '  age: \'(now() - file.ctime) / 86400000\'',
      '  label: \'title + " (" + status + ")"\'',
      'properties:',
      '  status:',
      '    displayName: State',
      'views:',
      '  - type: table',
      '    name: Board',
      '  - type: cards',
      '    name: Cards',
    ].join('\n'),
  },
];

/** Note frontmatter samples — the second exercises the date-coercion seam. */
export const FRONTMATTER_DOCS: { name: string; yaml: string }[] = [
  {
    name: 'mixed scalars + quotes + special chars',
    yaml: [
      'title: "Quarterly: Plan"',
      'priority: 3',
      'done: false',
      'tags:',
      '  - work',
      "  - q2",
    ].join('\n'),
  },
  {
    name: 'bare ISO date (js-yaml→Date, yaml→string; downstream-safe)',
    yaml: ['due: 2026-05-16', 'created: 2026-01-02T10:30:00Z'].join('\n'),
  },
  { name: 'empty document', yaml: '' },
];

/**
 * Differential corpus for the ADR-201 sandboxed evaluator (#180).
 *
 * Each case is a Bases filter/formula expression plus its expected value under
 * the *canonical* note context below. The current `new Function` evaluator is
 * the behavioural oracle: PR1 locks these expectations against it; PR2 asserts
 * the replacement library produces identical results before the swap lands.
 *
 * Time-dependent primitives (`now()`, `today()`) appear only inside relations
 * that are stable for all wall-clock times (e.g. a past date `<` today), so
 * expectations never rot.
 */

import type { NoteContext } from '../../src/types/bases-yaml';

/** Fixed file timestamps so duration math is deterministic. */
const CTIME = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z
const MTIME = Date.UTC(2026, 4, 1); // 2026-05-01T00:00:00Z — exactly 120 days after CTIME

/**
 * The single canonical context every EVAL_CASE is evaluated against. Built
 * fresh per call so a test mutating it cannot leak into others. Shape matches
 * what `ExpressionEvaluator.createEvalContext` reads — `file`/`cache` are
 * structural stand-ins (cast), not real Obsidian instances.
 */
export function makeNoteContext(): NoteContext {
  return {
    file: {
      basename: 'Quarterly Plan',
      path: 'Projects/Quarterly Plan.md',
      parent: { path: 'Projects' },
      extension: 'md',
      stat: { size: 1024, ctime: CTIME, mtime: MTIME },
    },
    cache: {
      tags: [{ tag: 'project' }, { tag: 'q2' }],
      links: [{ link: 'Roadmap' }, { link: 'Budget' }],
    },
    frontmatter: {
      title: 'Quarterly Plan',
      status: 'active',
      priority: 3,
      done: false,
      owner: 'alice',
      due: '2026-12-31', // date-coerced by createEvalContext (key === 'due')
      created: '2026-01-02', // date-coerced (key === 'created')
      tags: ['project', 'q2'],
    },
    formulas: { score: 42 },
  } as unknown as NoteContext;
}

/** An expression and its expected value under {@link makeNoteContext}. */
export interface EvalCase {
  expr: string;
  expected: unknown;
}

/**
 * ~50 cases spanning every operator class and every function/property the
 * evaluator exposes (date/now/today/number/string/iff/choice/min/max/abs/
 * round/list, file.hasTag/inFolder/hasLink/hasProperty, file.* props,
 * note./formula./bare-name resolution, ternary, string concat).
 */
export const EVAL_CASES: EvalCase[] = [
  // Bare-name (frontmatter via `with`) + comparisons
  { expr: 'status == "active"', expected: true },
  { expr: 'priority >= 3 && status != "done"', expected: true },
  { expr: 'priority < 3', expected: false },
  { expr: 'done', expected: false },
  { expr: '!done', expected: true },
  { expr: 'done == false', expected: true },
  { expr: 'owner == "alice" || owner == "bob"', expected: true },
  { expr: 'status', expected: 'active' },

  // Arithmetic
  { expr: 'priority + 1', expected: 4 },
  { expr: 'priority * 2 - 1', expected: 5 },
  { expr: 'priority / 2', expected: 1.5 },
  { expr: 'priority % 2', expected: 1 },

  // Ternary + string concat
  { expr: '(priority > 2) ? "hi" : "lo"', expected: 'hi' },
  { expr: 'title + " (" + status + ")"', expected: 'Quarterly Plan (active)' },
  { expr: '"a" + "b" + "c"', expected: 'abc' },

  // note. / formula. resolution
  { expr: 'note.status == "active"', expected: true },
  { expr: 'note.priority + note.priority', expected: 6 },
  { expr: 'formula.score > 40', expected: true },
  { expr: 'formula.score', expected: 42 },

  // file.* properties
  { expr: 'file.name', expected: 'Quarterly Plan' },
  { expr: 'file.path', expected: 'Projects/Quarterly Plan.md' },
  { expr: 'file.folder', expected: 'Projects' },
  { expr: 'file.ext == "md"', expected: true },
  { expr: 'file.size >= 1024', expected: true },
  { expr: 'file.ctime < file.mtime', expected: true },
  { expr: '(file.mtime - file.ctime) / 86400000', expected: 120 },
  { expr: 'file.tags', expected: ['#project', '#q2'] },
  { expr: 'file.links', expected: ['Roadmap', 'Budget'] },

  // file.* methods
  { expr: 'file.hasTag("project")', expected: true },
  { expr: 'file.hasTag("missing")', expected: false },
  { expr: 'file.hasTag("#q2")', expected: true },
  { expr: 'file.hasTag("a", "project")', expected: true },
  { expr: 'file.inFolder("Projects")', expected: true },
  { expr: 'file.inFolder("Other")', expected: false },
  { expr: 'file.hasLink("Roadmap")', expected: true },
  { expr: 'file.hasLink("[[Budget]]")', expected: true },
  { expr: 'file.hasLink("Nope")', expected: false },
  { expr: 'file.hasProperty("status")', expected: true },
  { expr: 'file.hasProperty("nonexistent")', expected: false },

  // Global functions
  { expr: 'min(3, 1, 2)', expected: 1 },
  { expr: 'max(priority, 10)', expected: 10 },
  { expr: 'abs(0 - 5)', expected: 5 },
  { expr: 'abs(-5)', expected: 5 },
  { expr: 'round(3.14159, 2)', expected: 3.14 },
  { expr: 'round(2.5)', expected: 3 },
  { expr: 'number("42") + 8', expected: 50 },
  { expr: 'string(priority)', expected: '3' },
  { expr: 'iff(priority > 2, "big", "small")', expected: 'big' },
  { expr: 'choice(done, "yes", "no")', expected: 'no' },
  { expr: 'list("x")', expected: ['x'] },
  { expr: 'list(file.tags)', expected: ['#project', '#q2'] },

  // Date functions — relations stable for all wall-clock times
  { expr: 'date("2020-01-01") < today()', expected: true },
  { expr: 'today() <= now()', expected: true },
  { expr: 'date("2026-12-31") > date("2026-01-01")', expected: true },
  { expr: 'note.due > date("2026-06-01")', expected: true },
  { expr: 'note.created < note.due', expected: true },
];

/**
 * Bare expression strings (back-compat narrative export; superset lives in
 * {@link EVAL_CASES}).
 */
export const FILTER_EXPRESSIONS: string[] = EVAL_CASES.map((c) => c.expr);

/**
 * Sandbox-escape attempts. The current `new Function` + `with` evaluator
 * EXECUTES these (PR1 proves the live RCE: `constructor.constructor` reaches
 * the `Function` constructor through the `with` scope chain). PR2's replacement
 * MUST refuse every one — throw, or return the evaluator's safe `false` — and
 * never reach a callable `Function`/global. This set is the concrete
 * "no globals reach" assertion, not a doc claim.
 */
export const SECURITY_EXPRESSIONS: string[] = [
  'constructor.constructor("return 1 + 1")()',
  'constructor.constructor("return 7")()',
  '({}).constructor.constructor("return 42")()',
  '(1).constructor.constructor("return 99")()',
  '"".constructor.constructor("return 5")()',
  '[].constructor.constructor("return 8")()',
  'file.constructor.constructor("return 3")()',
  'globalThis',
  'this',
  'note.__proto__',
  'note.constructor',
];
