import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

// Minimal text-file mock — combine only needs getFile to return content.
class MockAPI extends ObsidianAPI {
  private files = new Map<string, string>([
    ['a.md', 'ALPHA'],
    ['b.md', 'BRAVO'],
    ['c.md', 'CHARLIE'],
  ]);

  constructor() {
    super({} as App);
  }

  async getFile(path: string): Promise<any> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { content, path, type: 'text' };
  }
}

describe('vault combine — inline response (router level)', () => {
  let router: SemanticRouter;

  beforeEach(() => {
    router = new SemanticRouter(new MockAPI());
  });

  test('no destination returns inline content, writes nothing', async () => {
    const { result } = await router.route({
      operation: 'vault',
      action: 'combine',
      params: { paths: ['a.md', 'b.md'], separator: '\n' },
    }) as any;

    expect(result.success).toBe(true);
    expect(result.inline).toBe(true);
    expect(result.destination).toBeUndefined();
    expect(result.content).toBe('ALPHA\nBRAVO');
  });

  test('sourceFiles order matches the order content was combined in (regression)', async () => {
    // sortBy name desc → c, b, a — different from input order a, b, c.
    // sourceFiles must reflect the combined order, not the input order,
    // so consumers can map sections of `content` back to files.
    const { result } = await router.route({
      operation: 'vault',
      action: 'combine',
      params: {
        paths: ['a.md', 'b.md', 'c.md'],
        separator: '\n---\n',
        sortBy: 'name',
        sortOrder: 'desc',
      },
    }) as any;

    expect(result.inline).toBe(true);
    expect(result.content).toBe('CHARLIE\n---\nBRAVO\n---\nALPHA');
    expect(result.sourceFiles).toEqual(['c.md', 'b.md', 'a.md']);
  });
});
