import { parse, stringify } from 'yaml';

/**
 * Single seam for all YAML parsing/serialization in the Bases subsystem.
 *
 * Isolating the YAML library behind one module (rather than scattering
 * `yaml.load`/`yaml.dump` calls) keeps the dependency swappable and gives the
 * migration + future Bases work (ADR-201) one tested surface.
 *
 * Migrated from `js-yaml` to the maintained `yaml` package (#174). Behavioural
 * note: `js-yaml`'s default schema coerced bare/ISO dates into `Date`
 * objects; `yaml`'s default (YAML 1.2 core) keeps them as strings. This is
 * safe here because the only consumer of these values
 * (`expression-evaluator.ts`) already accepts both — it does
 * `value instanceof Date ? value : new Date(value)`.
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
