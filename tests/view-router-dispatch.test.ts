/**
 * view operation — router dispatch (#199 stage 2, operations/view.ts).
 *
 * Characterization tests: written against the router before
 * executeViewOperation moved out of router.ts, and kept unchanged across the
 * move. They drive the real SemanticRouter -> view handler path; only the
 * ObsidianAPI I/O boundary is stubbed. There was no router-level test for the
 * view operation before this extraction.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

class ViewAPI extends ObsidianAPI {
  public opened: string[] = [];
  public activeFile: () => Promise<any> = async () => ({ path: 'active.md', content: 'active body' });

  constructor(private files: Map<string, string>, private images: Set<string> = new Set()) {
    super({} as App);
  }

  async getFile(path: string): Promise<any> {
    if (this.images.has(path)) {
      return { path, mimeType: 'image/png', base64Data: 'AAAA' };
    }
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { path, content };
  }

  async getActiveFile(): Promise<any> {
    return this.activeFile();
  }

  async openFile(path: string): Promise<any> {
    this.opened.push(path);
    return { success: true };
  }
}

function setup(files: Record<string, string> = {}, images: string[] = []) {
  const api = new ViewAPI(new Map(Object.entries(files)), new Set(images));
  return { router: new SemanticRouter(api), api };
}

/** L1..Ln, one per line. */
function numberedLines(n: number, overrides: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => overrides[i + 1] ?? `L${i + 1}`).join('\n');
}

describe('view operation dispatch (router -> operations/view.ts)', () => {
  it('file returns the file as the API gave it', async () => {
    const { router } = setup({ 'a.md': 'body' });
    const response = await router.route({ operation: 'view', action: 'file', params: { path: 'a.md' } });
    expect(response.result).toEqual({ path: 'a.md', content: 'body' });
  });

  it('file without a path is rejected', async () => {
    const { router } = setup();
    const response = await router.route({ operation: 'view', action: 'file', params: {} });
    expect(response.error?.message).toBe("view.file requires 'path' (string, missing).");
  });

  it('window centres on the given line number', async () => {
    const { router } = setup({ 'a.md': numberedLines(30) });
    const response = await router.route({
      operation: 'view',
      action: 'window',
      params: { path: 'a.md', lineNumber: 15, windowSize: 4 }
    });
    expect(response.result).toEqual({
      path: 'a.md',
      lines: ['L13', 'L14', 'L15', 'L16', 'L17'],
      startLine: 13,
      endLine: 17,
      totalLines: 30,
      centerLine: 15,
      searchText: undefined
    });
  });

  it('window centres on the first fuzzy match of searchText with the default size', async () => {
    const { router } = setup({ 'a.md': numberedLines(30, { 25: 'the needle sits here' }) });
    const response = await router.route({
      operation: 'view',
      action: 'window',
      params: { path: 'a.md', searchText: 'the needle sits here' }
    });
    const result = response.result as Record<string, unknown>;
    expect(result.centerLine).toBe(25);
    expect(result.startLine).toBe(15);
    expect(result.endLine).toBe(30);
    expect(result.totalLines).toBe(30);
    expect(result.searchText).toBe('the needle sits here');
  });

  it('window refuses image files', async () => {
    const { router } = setup({}, ['pic.png']);
    const response = await router.route({ operation: 'view', action: 'window', params: { path: 'pic.png' } });
    expect(response.error?.message).toBe('Cannot view window of image files');
  });

  // view.active races the API against a 5s window timer. Fake timers keep
  // that timer from outliving the test, and let the timeout case run instantly.
  describe('active', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the active file', async () => {
      const { router } = setup();
      const response = await router.route({ operation: 'view', action: 'active', params: {} });
      expect(response.result).toEqual({ path: 'active.md', content: 'active body' });
    });

    it('passes an API error through unchanged', async () => {
      const { router, api } = setup();
      api.activeFile = async () => { throw new Error('No active file'); };
      const response = await router.route({ operation: 'view', action: 'active', params: {} });
      expect(response.error?.message).toBe('No active file');
    });

    it('times out after 5 seconds when no file answers', async () => {
      const { router, api } = setup();
      api.activeFile = () => new Promise(() => { /* never settles */ });
      const pending = router.route({ operation: 'view', action: 'active', params: {} });
      await jest.advanceTimersByTimeAsync(5000);
      const response = await pending;
      expect(response.error?.message).toBe('Timeout: No active file in Obsidian. Please open a file first.');
    });
  });

  it('open_in_obsidian opens the given path', async () => {
    const { router, api } = setup();
    const response = await router.route({
      operation: 'view',
      action: 'open_in_obsidian',
      params: { path: 'a.md' }
    });
    expect(response.result).toEqual({ success: true });
    expect(api.opened).toEqual(['a.md']);
  });

  it('open_in_obsidian without a path is rejected', async () => {
    const { router, api } = setup();
    const response = await router.route({ operation: 'view', action: 'open_in_obsidian', params: {} });
    expect(response.error?.message).toBe("view.open_in_obsidian requires 'path' (string, missing).");
    expect(api.opened).toEqual([]);
  });

  it('an unknown action is rejected', async () => {
    const { router } = setup();
    const response = await router.route({ operation: 'view', action: 'nope', params: {} });
    expect(response.error?.message).toBe('Unknown view action: nope');
  });
});
