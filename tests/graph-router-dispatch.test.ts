/**
 * graph operation — router dispatch (#199 stage 2, operations/graph.ts).
 *
 * Characterization tests: written against the router before
 * executeGraphOperation moved out of router.ts, and kept unchanged across the
 * move. The handler's job is to pick one of three graph tools by action and
 * map params onto it; the tools have their own suites (graph-search*.test.ts,
 * graph-tag...). Here the three tool classes are replaced by recorders so the
 * test sees exactly what the router hands each one. There was no router-level
 * test for the graph operation before this extraction.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

const mockCalls: Array<{ tool: string; params: unknown }> = [];

jest.mock('../src/tools/graph-search', () => ({
  GraphSearchTool: class {
    search(params: unknown) {
      mockCalls.push({ tool: 'search', params });
      return { from: 'search' };
    }
  }
}));

jest.mock('../src/tools/graph-search-tool', () => ({
  GraphSearchTool: class {
    async execute(params: unknown) {
      mockCalls.push({ tool: 'traversal', params });
      return { from: 'traversal' };
    }
  }
}));

jest.mock('../src/tools/graph-tag-tool', () => ({
  GraphTagTool: class {
    async execute(params: unknown) {
      mockCalls.push({ tool: 'tag', params });
      return { from: 'tag' };
    }
  }
}));

function setup(withApp = true) {
  const api = new ObsidianAPI({} as App);
  return withApp ? new SemanticRouter(api, {} as App) : new SemanticRouter(api);
}

describe('graph operation dispatch (router -> operations/graph.ts)', () => {
  beforeEach(() => {
    mockCalls.length = 0;
  });

  it.each(['search-traverse', 'advanced-traverse'])('%s goes to the traversal tool with mapped params', async (action) => {
    const response = await setup().route({
      operation: 'graph',
      action,
      params: {
        startPath: 'a.md',
        searchQuery: 'q',
        searchQueries: ['q1', 'q2'],
        maxDepth: 3,
        maxSnippetsPerNode: 2,
        scoreThreshold: 0.5,
        strategy: 'best-first',
        beamWidth: 4,
        includeOrphans: true,
        followTags: false,
        filePattern: '*.md',
        unrelated: 'dropped'
      }
    });
    expect(response.result).toEqual({ from: 'traversal' });
    expect(mockCalls).toEqual([{
      tool: 'traversal',
      params: {
        action,
        startPath: 'a.md',
        searchQuery: 'q',
        searchQueries: ['q1', 'q2'],
        maxDepth: 3,
        maxSnippetsPerNode: 2,
        scoreThreshold: 0.5,
        strategy: 'best-first',
        beamWidth: 4,
        includeOrphans: true,
        followTags: false,
        filePattern: '*.md'
      }
    }]);
  });

  it('search-traverse without a startPath sends an empty string', async () => {
    await setup().route({ operation: 'graph', action: 'search-traverse', params: {} });
    expect((mockCalls[0].params as { startPath: unknown }).startPath).toBe('');
  });

  it.each(['tag-traverse', 'tag-analysis', 'shared-tags'])('%s goes to the tag tool with mapped params', async (action) => {
    const response = await setup().route({
      operation: 'graph',
      action,
      params: {
        startPath: 'a.md',
        targetPath: 'b.md',
        searchQuery: 'q',
        maxDepth: 2,
        maxSnippetsPerNode: 1,
        scoreThreshold: 0.3,
        followTags: true,
        tagWeight: 0.8,
        unrelated: 'dropped'
      }
    });
    expect(response.result).toEqual({ from: 'tag' });
    expect(mockCalls).toEqual([{
      tool: 'tag',
      params: {
        action,
        startPath: 'a.md',
        targetPath: 'b.md',
        searchQuery: 'q',
        maxDepth: 2,
        maxSnippetsPerNode: 1,
        scoreThreshold: 0.3,
        followTags: true,
        tagWeight: 0.8
      }
    }]);
  });

  it('any other action goes to the graph search tool as its operation', async () => {
    const response = await setup().route({
      operation: 'graph',
      action: 'neighbors',
      params: {
        sourcePath: 'a.md',
        targetPath: 'b.md',
        maxDepth: 2,
        maxNodes: 50,
        includeUnresolved: true,
        followBacklinks: true,
        followForwardLinks: false,
        followTags: true,
        fileFilter: 'x',
        tagFilter: ['t1'],
        folderFilter: 'notes',
        unrelated: 'dropped'
      }
    });
    expect(response.result).toEqual({ from: 'search' });
    expect(mockCalls).toEqual([{
      tool: 'search',
      params: {
        operation: 'neighbors',
        sourcePath: 'a.md',
        targetPath: 'b.md',
        maxDepth: 2,
        maxNodes: 50,
        includeUnresolved: true,
        followBacklinks: true,
        followForwardLinks: false,
        followTags: true,
        fileFilter: 'x',
        tagFilter: ['t1'],
        folderFilter: 'notes'
      }
    }]);
  });

  it.each([
    ['search-traverse', 'Graph search traversal operations require Obsidian app context'],
    ['tag-analysis', 'Graph tag operations require Obsidian app context'],
    ['neighbors', 'Graph operations require Obsidian app context']
  ])('%s without an app context is rejected', async (action, message) => {
    const response = await setup(false).route({ operation: 'graph', action, params: {} });
    expect(response.error?.message).toBe(message);
    expect(mockCalls).toEqual([]);
  });
});
