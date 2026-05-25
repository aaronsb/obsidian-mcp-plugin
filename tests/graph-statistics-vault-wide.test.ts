/**
 * Tests for #132 — graph.statistics with optional sourcePath.
 *
 * Mocks vault.getFiles() and metadataCache.resolvedLinks so the
 * vault-wide aggregation runs deterministically against a known
 * adjacency. Per-node stats coverage stays intact.
 */
import { App, TFile } from 'obsidian';
import { GraphSearchTool } from '../src/tools/graph-search';
import { GraphTraversal } from '../src/utils/graph-traversal';
import { ObsidianAPI } from '../src/utils/obsidian-api';

function makeFile(path: string, extension = 'md'): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? path;
  file.basename = file.name.replace(new RegExp(`\\.${extension}$`), '');
  file.extension = extension;
  return file;
}

function buildApp(opts: {
  files: TFile[];
  resolvedLinks?: Record<string, Record<string, number>>;
}): App {
  const app = new App();
  (app as any).metadataCache = {
    resolvedLinks: opts.resolvedLinks ?? {},
    unresolvedLinks: {},
    getFileCache: jest.fn().mockReturnValue({ tags: [] }),
  };
  app.vault.getFiles = jest.fn(() => opts.files);
  const byPath = new Map(opts.files.map(f => [f.path, f]));
  app.vault.getAbstractFileByPath = jest.fn((p: string) => byPath.get(p) ?? null);
  return app;
}

describe('graph.statistics — vault-wide (#132)', () => {
  // Topology:
  //   A → B, A → C  (one component of size 3)
  //   D → E         (one component of size 2)
  //   F             (orphan)
  // = 3 components, 1 orphan, largest = 3, totalLinks = 3
  const A = makeFile('a.md');
  const B = makeFile('b.md');
  const C = makeFile('c.md');
  const D = makeFile('d.md');
  const E = makeFile('e.md');
  const F = makeFile('f.md');

  let tool: GraphSearchTool;

  beforeEach(() => {
    const app = buildApp({
      files: [A, B, C, D, E, F],
      resolvedLinks: {
        'a.md': { 'b.md': 1, 'c.md': 1 },
        'd.md': { 'e.md': 1 },
      },
    });
    tool = new GraphSearchTool({} as ObsidianAPI, app);
  });

  it('returns vaultStatistics when sourcePath is omitted', () => {
    const result = tool.search({ operation: 'statistics' });

    expect(result.statistics).toBeUndefined();
    expect(result.vaultStatistics).toEqual({
      totalNotes: 6,
      totalLinks: 3,
      orphanCount: 1,
      averageDegree: 1, // 2 * 3 / 6
      largestComponentSize: 3,
      isolatedClusters: 3,
    });
    expect(result.message).toContain('6 notes');
    expect(result.message).toContain('1 orphans');
  });

  it('still returns per-node statistics when sourcePath is provided', () => {
    const result = tool.search({ operation: 'statistics', sourcePath: 'a.md' });

    expect(result.vaultStatistics).toBeUndefined();
    expect(result.statistics).toMatchObject({
      outDegree: 2,
      inDegree: 0,
      totalDegree: 2,
    });
    expect(result.sourcePath).toBe('a.md');
  });

  it('counts repeated occurrences in totalLinks (Obsidian semantics)', () => {
    // A → B appears 3 times in the same file → counts as 3 totalLinks.
    const app = buildApp({
      files: [A, B],
      resolvedLinks: { 'a.md': { 'b.md': 3 } },
    });
    const t = new GraphSearchTool({} as ObsidianAPI, app);

    const result = t.search({ operation: 'statistics' });
    expect(result.vaultStatistics).toMatchObject({
      totalNotes: 2,
      totalLinks: 3,
      isolatedClusters: 1,
      largestComponentSize: 2,
    });
  });

  it('handles an empty vault without dividing by zero', () => {
    const app = buildApp({ files: [], resolvedLinks: {} });
    const t = new GraphSearchTool({} as ObsidianAPI, app);

    const result = t.search({ operation: 'statistics' });
    expect(result.vaultStatistics).toEqual({
      totalNotes: 0,
      totalLinks: 0,
      orphanCount: 0,
      averageDegree: 0,
      largestComponentSize: 0,
      isolatedClusters: 0,
    });
  });

  it('ignores non-markdown files in totalNotes', () => {
    const image = makeFile('img.png', 'png');
    const app = buildApp({
      files: [A, B, image],
      resolvedLinks: { 'a.md': { 'b.md': 1 } },
    });
    const t = new GraphSearchTool({} as ObsidianAPI, app);

    const result = t.search({ operation: 'statistics' });
    expect(result.vaultStatistics?.totalNotes).toBe(2);
  });

  it('treats the graph as undirected for component counting', () => {
    // B → A and A → B both link A↔B; they're one component, not two.
    const app = buildApp({
      files: [A, B],
      resolvedLinks: {
        'a.md': { 'b.md': 1 },
        'b.md': { 'a.md': 1 },
      },
    });
    const t = new GraphSearchTool({} as ObsidianAPI, app);

    const result = t.search({ operation: 'statistics' });
    expect(result.vaultStatistics).toMatchObject({
      isolatedClusters: 1,
      largestComponentSize: 2,
      totalLinks: 2,
    });
  });
});

describe('GraphTraversal.getVaultStatistics', () => {
  it('returns zeros for an empty vault', () => {
    const app = buildApp({ files: [], resolvedLinks: {} });
    const traversal = new GraphTraversal(app);
    expect(traversal.getVaultStatistics()).toEqual({
      totalNotes: 0,
      totalLinks: 0,
      orphanCount: 0,
      averageDegree: 0,
      largestComponentSize: 0,
      isolatedClusters: 0,
    });
  });
});
