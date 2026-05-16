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

  it('empty document parses to a nullish value (both libs)', () => {
    expect(parseYaml('')).toBeFalsy();
  });

  it('date coercion: yaml keeps strings where js-yaml made Dates, and new Date() reconciles (downstream-safe)', () => {
    const { yaml } = FRONTMATTER_DOCS[1];
    const fromBridge = parseYaml(yaml) as { due: unknown; created: unknown };
    const fromJsYaml = jsyaml.load(yaml) as { due: unknown; created: unknown };

    // js-yaml's default schema produced Date objects:
    expect(fromJsYaml.due).toBeInstanceOf(Date);
    // the bridge (yaml core schema) keeps the original string:
    expect(typeof fromBridge.due).toBe('string');

    // expression-evaluator.ts does `new Date(value)` on non-Date values, so
    // the representations reconcile to the same instant — the migration is
    // behaviour-preserving for the only consumer.
    expect(new Date(fromBridge.due as string).getTime()).toBe(
      (fromJsYaml.due as Date).getTime(),
    );
    expect(new Date(fromBridge.created as string).getTime()).toBe(
      (fromJsYaml.created as Date).getTime(),
    );
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
