import { App, TFile } from 'obsidian';
import { GraphSearchTool } from '../src/tools/graph-search';
import { ObsidianAPI } from '../src/utils/obsidian-api';

function makeFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? path;
  // getNodeTitle (added in #207, merged before this PR landed) reads
  // basename — make the mock match the real TFile API.
  file.basename = file.name.replace(/\.md$/, '');
  file.extension = 'md';
  return file;
}

describe('GraphSearchTool', () => {
  let app: App;
  let tool: GraphSearchTool;

  beforeEach(() => {
    const resolvedTarget = makeFile('resolved.md');

    app = new App();
    (app as any).metadataCache = {
      resolvedLinks: {
        'source.md': { 'resolved.md': 1 }
      },
      unresolvedLinks: {
        'source.md': { 'Missing Note': 1 }
      },
      getFileCache: jest.fn().mockReturnValue({ tags: [] })
    };
    app.vault.getAbstractFileByPath = jest.fn((path: string) =>
      path === 'resolved.md' ? resolvedTarget : null
    );

    tool = new GraphSearchTool({} as ObsidianAPI, app);
  });

  it('omits unresolved forward links by default', () => {
    const result = tool.search({
      operation: 'forwardlinks',
      sourcePath: 'source.md'
    });

    expect(result.edges).toEqual([
      { source: 'source.md', target: 'resolved.md', type: 'link', count: 1 }
    ]);
    expect(result.nodes).toEqual([
      expect.objectContaining({ path: 'resolved.md', title: 'resolved' })
    ]);
  });

  it('includes unresolved forward links when requested', () => {
    const result = tool.search({
      operation: 'forwardlinks',
      sourcePath: 'source.md',
      includeUnresolved: true
    });

    expect(result.edges).toEqual([
      { source: 'source.md', target: 'resolved.md', type: 'link', count: 1 },
      { source: 'source.md', target: 'Missing Note', type: 'link', count: 1 }
    ]);
    expect(result.nodes).toEqual([
      expect.objectContaining({ path: 'resolved.md', title: 'resolved' })
    ]);
    expect(result.message).toBe('Found 2 files linked from this file');
  });
});
