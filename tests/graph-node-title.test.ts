import { App, TFile } from 'obsidian';
import { GraphSearchTool } from '../src/tools/graph-search';
import { GraphTraversal } from '../src/utils/graph-traversal';
import { ObsidianAPI } from '../src/utils/obsidian-api';

function makeFile(path: string, basename: string, parentName?: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = `${basename}.md`;
  file.basename = basename;
  file.extension = 'md';
  (file as any).parent = parentName
    ? { name: parentName }
    : null;
  return file;
}

describe('graph node titles', () => {
  let app: App;
  let traversal: GraphTraversal;
  let search: GraphSearchTool;
  let indexFile: TFile;
  let regularFile: TFile;
  let sourceFile: TFile;

  beforeEach(() => {
    indexFile = makeFile('topics/rendering/index.md', 'index', 'rendering');
    regularFile = makeFile('topics/rendering/overview.md', 'overview', 'rendering');
    sourceFile = makeFile('source.md', 'source');

    const filesByPath = new Map([
      [indexFile.path, indexFile],
      [regularFile.path, regularFile],
      [sourceFile.path, sourceFile]
    ]);

    app = new App();
    (app as any).metadataCache = {
      resolvedLinks: {
        'source.md': { 'topics/rendering/index.md': 1 },
        'topics/rendering/index.md': { 'topics/rendering/overview.md': 1 }
      },
      unresolvedLinks: {},
      getFileCache: jest.fn().mockReturnValue({ tags: [] })
    };
    app.vault.getFiles = jest.fn(() => [indexFile, regularFile, sourceFile]);
    app.vault.getAbstractFileByPath = jest.fn((path: string) => filesByPath.get(path) ?? null);

    traversal = new GraphTraversal(app);
    search = new GraphSearchTool({ getIgnoreManager: () => undefined } as unknown as ObsidianAPI, app);
  });

  it('uses the parent folder as the graph title for index files', () => {
    expect(traversal.getNodeTitle(indexFile)).toBe('rendering');
    expect(traversal.getNodeTitle(regularFile)).toBe('overview');
  });

  it('uses resolved graph titles in vault node listings', () => {
    const nodes = traversal.getAllNodes();

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'topics/rendering/index.md', title: 'rendering' }),
        expect.objectContaining({ path: 'topics/rendering/overview.md', title: 'overview' })
      ])
    );
  });

  it('uses resolved graph titles in forwardlink results', () => {
    const result = search.search({ operation: 'forwardlinks', sourcePath: 'source.md' });

    expect(result.nodes).toEqual([
      expect.objectContaining({ path: 'topics/rendering/index.md', title: 'rendering' })
    ]);
  });

  it('uses resolved graph titles in backlink results', () => {
    const result = search.search({ operation: 'backlinks', sourcePath: 'topics/rendering/overview.md' });

    expect(result.nodes).toEqual([
      expect.objectContaining({ path: 'topics/rendering/index.md', title: 'rendering' })
    ]);
  });

  it('uses resolved graph titles in path results', () => {
    const result = search.search({
      operation: 'path',
      sourcePath: 'source.md',
      targetPath: 'topics/rendering/overview.md'
    });

    expect(result.paths?.[0]).toEqual([
      { path: 'source.md', title: 'source' },
      { path: 'topics/rendering/index.md', title: 'rendering' },
      { path: 'topics/rendering/overview.md', title: 'overview' }
    ]);
  });
});
