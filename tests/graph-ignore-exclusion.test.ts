import { App, TFile } from 'obsidian';
import { GraphTraversal } from '../src/utils/graph-traversal';
import { GraphSearchTool } from '../src/tools/graph-search';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { MCPIgnoreManager } from '../src/security/mcp-ignore-manager';

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? path;
  file.basename = file.name.replace(/\.md$/, '');
  file.extension = 'md';
  (file as any).stat = { mtime: 0, ctime: 0, size: 0 };
  return file;
}

// Fake ignore manager that excludes anything under _build/backups/
const ignoreManager = {
  isExcluded: (path: string) => path.startsWith('_build/backups/')
} as unknown as MCPIgnoreManager;

const FILES: Record<string, TFile> = {
  'stack/index.md': makeFile('stack/index.md'),
  'real.md': makeFile('real.md'),
  '_build/backups/snapshot.md': makeFile('_build/backups/snapshot.md'),
  '_build/backups/old.md': makeFile('_build/backups/old.md')
};

// Per-path tag cache — all four notes share #archived
const TAGS: Record<string, string> = {
  'stack/index.md': '#archived',
  'real.md': '#archived',
  '_build/backups/snapshot.md': '#archived',
  '_build/backups/old.md': '#archived'
};

function makeApp(): App {
  const app = new App();
  (app as any).metadataCache = {
    resolvedLinks: {
      // stack/index.md links out to a real note AND a backup note
      'stack/index.md': { 'real.md': 1, '_build/backups/old.md': 1 },
      // a backup snapshot links back into stack/index.md
      '_build/backups/snapshot.md': { 'stack/index.md': 1 },
      'real.md': { 'stack/index.md': 1 }
    },
    unresolvedLinks: {},
    getFileCache: jest.fn((file: any) => ({
      tags: TAGS[file?.path] ? [{ tag: TAGS[file.path] }] : []
    }))
  };
  app.vault.getAbstractFileByPath = jest.fn((path: string) => FILES[path] ?? null);
  app.vault.getFiles = jest.fn(() => Object.values(FILES));
  return app;
}

/**
 * Graph traversal reads metadataCache.resolvedLinks and vault.getFiles()
 * directly, both unaware of .mcpignore. These tests pin that ignored paths are
 * kept out of (a) the link primitives, (b) the file enumerations (root, tags,
 * vault stats, all-nodes), and (c) are rejected as query roots at the
 * GraphSearchTool boundary so a direct query can't disclose their relationships.
 */
describe('GraphTraversal — link primitives & enumerations honor exclusions', () => {
  let app: App;
  beforeEach(() => { app = makeApp(); });

  it('filters excluded sources out of backlinks', () => {
    const sources = new GraphTraversal(app, ignoreManager).getBacklinks('stack/index.md').map(e => e.source);
    expect(sources).toContain('real.md');
    expect(sources).not.toContain('_build/backups/snapshot.md');
  });

  it('filters excluded targets out of forward links', () => {
    const targets = new GraphTraversal(app, ignoreManager).getForwardLinks('stack/index.md').map(e => e.target);
    expect(targets).toContain('real.md');
    expect(targets).not.toContain('_build/backups/old.md');
  });

  it('keeps excluded nodes out of the local neighborhood', () => {
    const { neighbors, edges } = new GraphTraversal(app, ignoreManager).getLocalNeighborhood('stack/index.md');
    const paths = neighbors.map(n => n.path);
    expect(paths).toContain('real.md');
    expect(paths).not.toContain('_build/backups/old.md');
    expect(paths).not.toContain('_build/backups/snapshot.md');
    expect(edges.every(e => !e.source.startsWith('_build/backups/') && !e.target.startsWith('_build/backups/'))).toBe(true);
  });

  it('excludes ignored files from the root neighborhood', () => {
    const { neighbors } = new GraphTraversal(app, ignoreManager).getLocalNeighborhood('/');
    expect(neighbors.map(n => n.path).some(p => p.startsWith('_build/backups/'))).toBe(false);
  });

  it('excludes ignored files from getAllNodes', () => {
    const paths = new GraphTraversal(app, ignoreManager).getAllNodes().map(n => n.path);
    expect(paths).toContain('stack/index.md');
    expect(paths.some(p => p.startsWith('_build/backups/'))).toBe(false);
  });

  it('excludes ignored files from tag connections', () => {
    const targets = new GraphTraversal(app, ignoreManager).getTagConnections('stack/index.md').map(e => e.target);
    expect(targets).toContain('real.md');
    expect(targets.some(p => p.startsWith('_build/backups/'))).toBe(false);
  });

  it('excludes ignored files from vault statistics totalNotes', () => {
    // 4 files total, 2 under _build/backups/ → only 2 visible notes
    expect(new GraphTraversal(app, ignoreManager).getVaultStatistics().totalNotes).toBe(2);
  });

  it('leaves everything unfiltered when no ignore manager is configured', () => {
    const t = new GraphTraversal(app);
    expect(t.getForwardLinks('stack/index.md').map(e => e.target)).toContain('_build/backups/old.md');
    expect(t.getBacklinks('stack/index.md').map(e => e.source)).toContain('_build/backups/snapshot.md');
    expect(t.getVaultStatistics().totalNotes).toBe(4);
  });
});

describe('GraphSearchTool — rejects excluded query roots (no relationship disclosure)', () => {
  let tool: GraphSearchTool;
  beforeEach(() => {
    const app = makeApp();
    tool = new GraphSearchTool({ getIgnoreManager: () => ignoreManager } as unknown as ObsidianAPI, app);
  });

  for (const operation of ['backlinks', 'forwardlinks', 'neighbors', 'statistics'] as const) {
    it(`throws "File not found" for ${operation} on an excluded sourcePath`, () => {
      expect(() => tool.search({ operation, sourcePath: '_build/backups/snapshot.md' }))
        .toThrow(/File not found/);
    });
  }

  it('throws "File not found" for path when targetPath is excluded', () => {
    expect(() => tool.search({ operation: 'path', sourcePath: 'real.md', targetPath: '_build/backups/old.md' }))
      .toThrow(/File not found/);
  });

  it('does not reject the "/" vault root, and the root excludes ignored neighbors', () => {
    const result = tool.search({ operation: 'neighbors', sourcePath: '/' });
    expect((result.nodes ?? []).map(n => n.path).some(p => p.startsWith('_build/backups/'))).toBe(false);
  });
});
