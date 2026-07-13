/**
 * vault.fragments — the `path` parameter must scope the search.
 *
 * Measured failure: asking for fragments from one note returned "fragments across 3
 * files", with the top-scoring passage coming from a different note entirely. The `path`
 * param was only read as a fallback *query* string, never as a scope, so an agent that
 * reasoned "these are the key passages in the note I named" would attribute content to
 * the wrong file. That is a correctness trap, not a presentation nit.
 */
import { UniversalFragmentRetriever } from '../src/indexing/fragment-retriever';

const TARGET = 'scaled-sandwich/organizational-patterns.md';
const OTHER = 'scaled-sandwich/README.md';

function retrieverWithTwoDocs(): UniversalFragmentRetriever {
  const retriever = new UniversalFragmentRetriever();

  retriever.indexDocument(
    `file:${TARGET}`,
    TARGET,
    [
      '# Organizational patterns',
      'Kanban WIP limits prevent overwhelming the human reviewer, maintaining quality.',
      'Pull systems prevent overload. Span of control caps the reviewer at seven items.',
      'Context switching is expensive, so batch similar decisions together.'
    ].join('\n\n')
  );

  retriever.indexDocument(
    `file:${OTHER}`,
    OTHER,
    [
      '# Readme',
      'Pull, do not push: use WIP limits to prevent overwhelming reviewers.',
      'Trust is earned through progressive autonomy and Kanban flow management.'
    ].join('\n\n')
  );

  return retriever;
}

describe('fragment retrieval scoping', () => {
  // 'adaptive' is pinned in the spanning pair below rather than relying on 'auto':
  // auto picks a strategy per query, and on a corpus this small it may happen to return
  // hits from one document, which would make the control vacuously pass.
  it('should return fragments from every indexed document when unscoped', () => {
    const retriever = retrieverWithTwoDocs();

    const response = retriever.retrieveFragments('kanban WIP limits reviewer', {
      maxFragments: 10,
      strategy: 'adaptive'
    });
    const paths = new Set((response.result ?? []).map(f => f.docPath));

    expect(paths.has(TARGET)).toBe(true);
    expect(paths.has(OTHER)).toBe(true);
  });

  it('should return fragments only from the scoped document', () => {
    const retriever = retrieverWithTwoDocs();

    const response = retriever.retrieveFragments('kanban WIP limits reviewer', {
      maxFragments: 10,
      strategy: 'adaptive',
      scopePath: TARGET
    });
    const paths = new Set((response.result ?? []).map(f => f.docPath));

    expect(paths.has(OTHER)).toBe(false);
    expect([...paths]).toEqual([TARGET]);
  });

  it('should scope under the default auto strategy too', () => {
    const retriever = retrieverWithTwoDocs();

    const response = retriever.retrieveFragments('kanban WIP limits reviewer', {
      maxFragments: 10,
      scopePath: TARGET
    });

    expect((response.result ?? []).every(f => f.docPath === TARGET)).toBe(true);
  });

  it('should still find fragments in the scoped document when another document ranks higher', () => {
    const retriever = retrieverWithTwoDocs();

    // Scoping must not simply filter the unscoped top-N — if the other document's
    // passages outrank the target's, filtering afterwards would return nothing.
    const response = retriever.retrieveFragments('pull systems prevent overload', {
      maxFragments: 1,
      scopePath: TARGET
    });

    expect(response.result?.length).toBeGreaterThan(0);
    expect(response.result?.[0].docPath).toBe(TARGET);
  });

  it('should return no fragments when scoped to a document that was never indexed', () => {
    const retriever = retrieverWithTwoDocs();

    const response = retriever.retrieveFragments('kanban', {
      maxFragments: 5,
      scopePath: 'nowhere/missing.md'
    });

    expect(response.result ?? []).toEqual([]);
  });
});
