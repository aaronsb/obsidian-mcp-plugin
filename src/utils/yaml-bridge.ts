import { parse, stringify } from 'yaml';

/**
 * Single seam for all YAML parsing/serialization in the Bases subsystem.
 *
 * Isolating the YAML library behind one module (rather than scattering
 * `yaml.load`/`yaml.dump` calls) keeps the dependency swappable and gives the
 * migration + future Bases work (ADR-201) one tested surface.
 *
 * Migrated from `js-yaml` to the maintained `yaml` package (#174).
 *
 * Behavioural note — date scalars: `js-yaml`'s default schema coerced
 * bare/ISO dates into `Date` objects; `yaml`'s default (YAML 1.2 core) keeps
 * them as strings. This is safe for three independent reasons:
 *   1. Obsidian's metadata cache is the *primary* frontmatter source
 *      (`bases-api.ts` createNoteContext); this parser's `parseFrontmatter`
 *      is only a last-resort fallback, so the dominant path never used
 *      js-yaml's coercion anyway.
 *   2. When the fallback does run, `expression-evaluator.ts` pre-processes
 *      date-like frontmatter keys with `new Date(value)` (the
 *      "auto-convert date-like strings" block), reconciling string vs Date.
 *   3. `.base` documents carry no date scalars — only filter/formula/view
 *      config — so `.base` parsing has zero date exposure.
 *
 * Behavioural note — known divergences (acceptable; not exercised by
 * `.base`/frontmatter in practice, asserted in tests/bases-yaml.test.ts):
 * YAML merge keys (`<<: *anchor`) are resolved by js-yaml but kept literal
 * by `yaml`; an empty document parses to `null` (vs js-yaml's `undefined`) —
 * `parseFrontmatter`'s `typeof === 'object' && !== null` guard neutralizes
 * this identically; serialized scalar quoting is round-trip-equivalent but
 * not byte-identical to js-yaml (e.g. `yes` emitted bare, not quoted).
 */

/**
 * Parse a YAML document (a `.base` file body or note frontmatter).
 *
 * @param content - Raw YAML text.
 * @returns The parsed value, or `undefined`/`null` for an empty document.
 */
export function parseYaml(content: string): unknown {
  return parse(content);
}

/**
 * Serialize a Bases config object to YAML for `.base` file creation.
 *
 * Option mapping from the previous `js-yaml.dump` call:
 * - `lineWidth: 0`            ← js-yaml `lineWidth: -1` (never wrap lines)
 * - `aliasDuplicateObjects:false` ← js-yaml `noRefs: true` (no `&`/`*` refs)
 * - `singleQuote: false`      ← js-yaml `quotingType: '"'` (double quotes;
 *                               quote only when necessary, i.e. no forceQuotes)
 *
 * @param config - The Bases configuration object.
 * @returns YAML text suitable for writing to a `.base` file.
 */
export function stringifyBaseConfig(config: unknown): string {
  return stringify(config, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    singleQuote: false,
  });
}
