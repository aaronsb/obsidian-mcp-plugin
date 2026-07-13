/**
 * Path fidelity in agent-facing output.
 *
 * A path is an identifier, not prose. It is the value the agent must hand back to
 * vault.read / graph.neighbors on the very next call, so any beautification of it —
 * eliding the middle, or printing only the basename — makes the result unusable and
 * forces the agent to guess, re-search, or fabricate.
 *
 * Two measured failures motivate these tests:
 *  - vault.search elided long paths to `first/.../last`, so a search hit could not be
 *    fed into vault.read. Agents fell back to another search, which is exactly the
 *    repeated-search-instead-of-graph-follow behaviour we want to stop rewarding.
 *  - vault.list printed only the basename, implying files live directly under the
 *    directory that was listed. Joining the two produced a path that does not exist,
 *    and the read failed.
 */
import { formatFileList } from '../../src/formatters/vault';
import { formatSearchResults } from '../../src/formatters/search';

// A real path from the test corpus: nested, long, and non-ASCII (em-dash).
const DEEP_PATH = 'Part IV — How We Move It/7. Integration disposition/7.3 The MRP-API hidden hub and its dependency cluster.md';

describe('formatSearchResults', () => {
  it('should emit the full path of a hit so it can be passed straight to vault.read', () => {
    const output = formatSearchResults({
      query: 'MRP-API',
      results: [{ path: DEEP_PATH, title: '7.3 The MRP-API hidden hub', score: 1.42 }],
      totalResults: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1
    });

    expect(output).toContain(DEEP_PATH);
    expect(output).not.toContain('/.../');
  });
});

describe('formatFileList', () => {
  it('should emit full vault-relative paths for a string-array response', () => {
    const output = formatFileList([DEEP_PATH]);

    expect(output).toContain(DEEP_PATH);
  });

  it('should emit full vault-relative paths for a structured response', () => {
    const output = formatFileList({
      directory: 'Part IV — How We Move It',
      files: [
        { path: DEEP_PATH, name: '7.3 The MRP-API hidden hub and its dependency cluster.md' }
      ]
    });

    expect(output).toContain(DEEP_PATH);
  });

  it('should not imply a nested file sits directly under the listed directory', () => {
    // The bug: only the basename was printed, so an agent joined the directory it asked
    // for with the name it was given and produced a path that does not exist on disk.
    const output = formatFileList({
      directory: 'Part IV — How We Move It',
      files: [
        { path: DEEP_PATH, name: '7.3 The MRP-API hidden hub and its dependency cluster.md' }
      ]
    });

    const fabricated = 'Part IV — How We Move It/7.3 The MRP-API hidden hub and its dependency cluster.md';
    expect(output).not.toContain(fabricated);
  });

  it('should still show folders with their full path', () => {
    const output = formatFileList({
      directory: '',
      files: [
        { path: 'Part IV — How We Move It/7. Integration disposition', name: '7. Integration disposition', isFolder: true }
      ]
    });

    expect(output).toContain('Part IV — How We Move It/7. Integration disposition');
  });
});
