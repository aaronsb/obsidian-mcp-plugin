/**
 * graph.statistics — vault-wide shape.
 *
 * Called without a sourcePath, the operation returns { vaultStatistics: {...} } and no
 * sourcePath at all. The formatter read sourcePath unconditionally, threw, and dropped
 * the caller into a raw-JSON fallback prefixed "Formatter error". The agent still got
 * data, so nothing failed loudly — it just got the ugly path every time.
 */
import { formatGraphStats } from '../../src/formatters/graph';

const DENSE = {
  totalNotes: 58,
  totalLinks: 451,
  orphanCount: 0,
  averageDegree: 15.55,
  largestComponentSize: 58,
  isolatedClusters: 1
};

describe('formatGraphStats — vault-wide', () => {
  it('should format vault-wide statistics without throwing', () => {
    expect(() => formatGraphStats({ vaultStatistics: DENSE })).not.toThrow();
  });

  it('should report the headline counts', () => {
    const output = formatGraphStats({ vaultStatistics: DENSE });

    expect(output).toContain('58');
    expect(output).toContain('451');
  });

  it('should steer a densely linked vault toward following links', () => {
    const output = formatGraphStats({ vaultStatistics: DENSE });

    expect(output).toContain('graph.neighbors');
  });

  it('should steer a sparsely linked vault toward search instead', () => {
    const output = formatGraphStats({
      vaultStatistics: { totalNotes: 200, totalLinks: 40, orphanCount: 150, averageDegree: 0.4 }
    });

    expect(output).toContain('vault.search');
  });
});

describe('formatGraphStats — per-note', () => {
  it('should still format a single-note response', () => {
    const output = formatGraphStats({
      sourcePath: 'notes/hub.md',
      statistics: { inDegree: 4, outDegree: 7, totalDegree: 11 }
    });

    expect(output).toContain('hub.md');
    expect(output).toContain('11');
  });

  it('should flag an orphan note', () => {
    const output = formatGraphStats({
      sourcePath: 'notes/lonely.md',
      statistics: { inDegree: 0, outDegree: 0, totalDegree: 0 }
    });

    expect(output).toContain('orphan');
  });
});
