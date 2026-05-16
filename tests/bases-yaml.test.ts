/**
 * Differential migration tests for #174: js-yaml → `yaml`.
 *
 * `js-yaml` is still resolvable transitively (devDeps), so it serves as the
 * behavioural oracle: the new bridge must parse/serialize identically, with
 * exactly one documented, proven-safe exception (date coercion).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires -- js-yaml kept only as test oracle; @types removed in #174
const jsyaml: { load(s: string): unknown } = require('js-yaml');

import { parseYaml, stringifyBaseConfig } from '../src/utils/yaml-bridge';
import { BASE_DOCS, FRONTMATTER_DOCS } from './fixtures/base-corpus';

describe('yaml-bridge parse — differential vs js-yaml oracle (#174)', () => {
  for (const { name, yaml } of BASE_DOCS) {
    it(`parses identically to js-yaml: ${name}`, () => {
      expect(parseYaml(yaml)).toEqual(jsyaml.load(yaml));
    });
  }

  it('parses mixed scalars/quotes identically to js-yaml', () => {
    const { yaml } = FRONTMATTER_DOCS[0];
    expect(parseYaml(yaml)).toEqual(jsyaml.load(yaml));
  });

  it('empty document: yaml→null vs js-yaml→undefined (real divergence, neutralized downstream)', () => {
    // Concrete values, not toBeFalsy — this is a genuine divergence.
    expect(parseYaml('')).toBeNull(); // `yaml`
    expect(jsyaml.load('')).toBeUndefined(); // js-yaml
    // Safe: parseFrontmatter's guard is `typeof p === 'object' && p !== null`,
    // so both null and undefined fall through to `{}` identically. An empty
    // `.base` is invalid under either lib (no `views`) — same failure mode.
  });

  it('date coercion: yaml keeps strings where js-yaml made Dates, and new Date() reconciles (downstream-safe)', () => {
    const { yaml } = FRONTMATTER_DOCS[1];
    const fromBridge = parseYaml(yaml) as { due: unknown; created: unknown };
    const fromJsYaml = jsyaml.load(yaml) as { due: unknown; created: unknown };

    // js-yaml's default schema produced Date objects:
    expect(fromJsYaml.due).toBeInstanceOf(Date);
    // the bridge (yaml core schema) keeps the original string:
    expect(typeof fromBridge.due).toBe('string');

    // Safe because (1) Obsidian's metadata cache is the primary frontmatter
    // source — this parser is only a fallback; (2) when it does run,
    // expression-evaluator.ts auto-coerces date-like keys via
    // `new Date(value)`; (3) .base docs carry no date scalars. The
    // representations reconcile to the same instant either way.
    expect(new Date(fromBridge.due as string).getTime()).toBe(
      (fromJsYaml.due as Date).getTime(),
    );
    expect(new Date(fromBridge.created as string).getTime()).toBe(
      (fromJsYaml.created as Date).getTime(),
    );
  });
});

describe('yaml-bridge — known, accepted divergences from js-yaml (#174)', () => {
  // These differences are real but not exercised by `.base` configs or note
  // frontmatter in practice. Asserting them documents the boundary so a
  // future change into this territory is a deliberate, tested decision.

  it('merge keys: js-yaml resolves `<<: *anchor`, yaml keeps it literal', () => {
    const doc = ['base: &b', '  a: 1', 'derived:', '  <<: *b', '  c: 2'].join('\n');
    const js = jsyaml.load(doc) as { derived: Record<string, unknown> };
    const br = parseYaml(doc) as { derived: Record<string, unknown> };
    expect(js.derived).toEqual({ a: 1, c: 2 }); // merge resolved
    expect(br.derived).toEqual({ '<<': { a: 1 }, c: 2 }); // kept literal
    // Acceptable: `.base`/frontmatter never use merge keys.
  });

  it('input anchors/aliases still resolve structurally in both libs', () => {
    const doc = ['x: &v hello', 'y: *v'].join('\n');
    expect(parseYaml(doc)).toEqual({ x: 'hello', y: 'hello' });
    expect(jsyaml.load(doc)).toEqual({ x: 'hello', y: 'hello' });
  });
});

describe('yaml-bridge stringifyBaseConfig — option fidelity (#174)', () => {
  it('round-trips every base doc through serialize → parse', () => {
    for (const { yaml } of BASE_DOCS) {
      const obj = parseYaml(yaml);
      expect(parseYaml(stringifyBaseConfig(obj))).toEqual(obj);
    }
  });

  it('never wraps long lines (js-yaml lineWidth:-1 → yaml lineWidth:0)', () => {
    const longValue = 'x'.repeat(400);
    const out = stringifyBaseConfig({ note: longValue });
    // the 400-char value must remain on a single physical line
    expect(out.split('\n').some((l) => l.length >= 400)).toBe(true);
  });

  it('emits no anchors/aliases for duplicated objects (js-yaml noRefs)', () => {
    const shared = { type: 'table', name: 'Shared' };
    const out = stringifyBaseConfig({ views: [shared, shared] });
    expect(out).not.toMatch(/[*&]/);
    // and it still round-trips to two equivalent entries
    const parsed = parseYaml(out) as { views: unknown[] };
    expect(parsed.views).toEqual([shared, shared]);
  });
});
