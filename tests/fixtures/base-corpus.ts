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
 * Bare Bases filter/formula expression strings (for ADR-201 / #180 reuse).
 * Not YAML — the expressions a sandboxed evaluator must handle identically.
 */
export const FILTER_EXPRESSIONS: string[] = [
  'status == "active"',
  'priority >= 3 && status != "done"',
  'file.hasTag("project") || file.hasTag("urgent")',
  '(now() - file.ctime) / 86400000 > 7',
  'title + " (" + status + ")"',
];
