/**
 * Search results must not overstate what the score means.
 *
 * Measured failure: on a corpus where most notes mention the query term, TF-IDF scores
 * compress into a narrow band. The best-answering note scored 1.42 ("Good") while five
 * other load-bearing notes scored 0.36-0.45 and were all labelled "Low". An agent that
 * pruned at "Low" would have discarded every note in the answer except the anchor.
 *
 * The number was never the problem — the adjective was. TF-IDF has no absolute scale, so
 * a fixed band like "Good ≥ 1.0" asserts a relevance judgement the score cannot support.
 */
import { interpretScore } from '../../src/formatters/utils';
import { formatSearchResults } from '../../src/formatters/search';

const ANCHOR = 'Part IV — How We Move It/7. Integration disposition/7.3 The MRP-API hidden hub.md';
const BURIED = 'Part II — The Instance As It Stands/2. Current-state characterization/2.11 The integration coupling topology.md';

// The real distribution that triggered the bug: one clear top hit, and load-bearing
// notes bunched far below it.
const COMPRESSED = {
  query: 'MRP-API',
  results: [
    { path: ANCHOR, title: '7.3 The MRP-API hidden hub', score: 1.42 },
    { path: BURIED, title: '2.11 The integration coupling topology', score: 0.36 }
  ],
  totalResults: 2,
  page: 1,
  pageSize: 10,
  totalPages: 1
};

describe('interpretScore', () => {
  it('should not label a score with a quality adjective', () => {
    const rendered = [2.5, 1.42, 0.6, 0.36].map(s => interpretScore(s, 2.5)).join(' ');

    expect(rendered).not.toMatch(/Excellent|Good|Moderate|Low/);
  });

  it('should show the score itself', () => {
    expect(interpretScore(1.42, 1.42)).toContain('1.42');
  });

  it('should express a trailing score as a share of the top hit', () => {
    // Makes the compression visible: 0.36 is not "low quality", it is 25% of this run's
    // best term-frequency score — a fact about the query, not about the note.
    expect(interpretScore(0.36, 1.42)).toContain('25%');
  });

  it('should not claim a share for the top hit itself', () => {
    expect(interpretScore(1.42, 1.42)).not.toContain('%');
  });
});

describe('formatSearchResults — score presentation', () => {
  it('should not label any result with a quality adjective', () => {
    const output = formatSearchResults(COMPRESSED);

    expect(output).not.toMatch(/Excellent|Good|Moderate|Low/);
  });

  it('should warn against pruning on score when several results are returned', () => {
    const output = formatSearchResults(COMPRESSED);

    expect(output).toMatch(/do not prune on score/i);
  });

  it('should still point at the graph to expand from the top hit', () => {
    const output = formatSearchResults(COMPRESSED);

    expect(output).toContain('graph.neighbors');
    expect(output).toContain(ANCHOR);
  });
});
