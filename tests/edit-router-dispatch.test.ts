/**
 * edit operation — router dispatch (#199 stage 2, operations/edit.ts).
 *
 * Characterization tests: written against the router before
 * executeEditOperation moved out of router.ts, and kept unchanged across the
 * move. They drive the real SemanticRouter -> edit handler path; only the
 * ObsidianAPI I/O boundary is stubbed. The #139 lock and the #210 guards have
 * their own suites (file-lock-edit-serialization, dispatch-param-guards); this
 * file covers the per-action behaviour those leave out.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI, PatchParams } from '../src/utils/obsidian-api';
import { ContentBufferManager } from '../src/utils/content-buffer';
import { App } from 'obsidian';

class FileAPI extends ObsidianAPI {
  public patches: Array<{ path: string; params: PatchParams }> = [];

  constructor(public files: Map<string, string>, private images: Set<string> = new Set()) {
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

  async updateFile(path: string, content: string): Promise<any> {
    this.files.set(path, content);
    return { success: true, path };
  }

  async appendToFile(path: string, content: string): Promise<any> {
    this.files.set(path, (this.files.get(path) ?? '') + content);
    return { success: true, path };
  }

  async patchVaultFile(path: string, params: PatchParams): Promise<any> {
    this.patches.push({ path, params });
    return { success: true, path, patched: true };
  }
}

function setup(files: Record<string, string> = {}, images: string[] = []) {
  const api = new FileAPI(new Map(Object.entries(files)), new Set(images));
  return { router: new SemanticRouter(api), api };
}

describe('edit operation dispatch (router -> operations/edit.ts)', () => {
  beforeEach(() => {
    ContentBufferManager.getInstance().clear();
  });

  it('window replaces an exact match and reports it', async () => {
    const { router, api } = setup({ 'a.md': 'hello world' });
    const response = await router.route({
      operation: 'edit',
      action: 'window',
      params: { path: 'a.md', oldText: 'world', newText: 'there' }
    });
    expect(response.result).toEqual({
      content: [{ type: 'text', text: 'Successfully replaced exact match in a.md' }]
    });
    expect(api.files.get('a.md')).toBe('hello there');
  });

  it('window surfaces a no-match result as an error and leaves the file alone', async () => {
    const { router, api } = setup({ 'a.md': 'hello world' });
    const response = await router.route({
      operation: 'edit',
      action: 'window',
      params: { path: 'a.md', oldText: 'qqqqqqqqqqqq', newText: 'x' }
    });
    expect(response.error?.message).toBe(
      'No matches found for "qqqqqqqqqqqq" in a.md. Content has been buffered. ' +
      'You can use edit_vault_from_buffer to retry with different search text or ' +
      'insert_vault_at_line to insert at a specific line.'
    );
    expect(api.files.get('a.md')).toBe('hello world');
  });

  it('append adds content to the file', async () => {
    const { router, api } = setup({ 'a.md': 'one' });
    const response = await router.route({
      operation: 'edit',
      action: 'append',
      params: { path: 'a.md', content: '\ntwo' }
    });
    expect(response.result).toEqual({ success: true, path: 'a.md' });
    expect(api.files.get('a.md')).toBe('one\ntwo');
  });

  it('patch maps oldText/newText to old_text/new_text and passes the rest through', async () => {
    const { router, api } = setup({ 'a.md': 'x' });
    const response = await router.route({
      operation: 'edit',
      action: 'patch',
      params: {
        path: 'a.md',
        operation: 'append',
        targetType: 'heading',
        target: 'Notes',
        content: 'body',
        oldText: 'old',
        newText: 'new'
      }
    });
    expect(response.result).toEqual({ success: true, path: 'a.md', patched: true });
    expect(api.patches).toEqual([{
      path: 'a.md',
      params: {
        operation: 'append',
        targetType: 'heading',
        target: 'Notes',
        content: 'body',
        old_text: 'old',
        new_text: 'new'
      }
    }]);
  });

  it('at_line replaces line 1 by default', async () => {
    const { router, api } = setup({ 'a.md': 'L1\nL2' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md', content: 'NEW' }
    });
    expect(response.result).toEqual({ success: true, line: 1, mode: 'replace' });
    expect(api.files.get('a.md')).toBe('NEW\nL2');
  });

  it('at_line inserts before the given line', async () => {
    const { router, api } = setup({ 'a.md': 'L1\nL2' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md', content: 'NEW', lineNumber: 2, mode: 'before' }
    });
    expect(response.result).toEqual({ success: true, line: 2, mode: 'before' });
    expect(api.files.get('a.md')).toBe('L1\nNEW\nL2');
  });

  it('at_line inserts after the given line', async () => {
    const { router, api } = setup({ 'a.md': 'L1\nL2' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md', content: 'NEW', lineNumber: 2, mode: 'after' }
    });
    expect(response.result).toEqual({ success: true, line: 2, mode: 'after' });
    expect(api.files.get('a.md')).toBe('L1\nL2\nNEW');
  });

  it('at_line rejects a line number past the end of the file', async () => {
    const { router, api } = setup({ 'a.md': 'L1\nL2' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md', content: 'NEW', lineNumber: 4 }
    });
    expect(response.error?.message).toBe('Invalid line number 4. File has 2 lines.');
    expect(api.files.get('a.md')).toBe('L1\nL2');
  });

  it('at_line falls back to buffered content when none is given', async () => {
    ContentBufferManager.getInstance().store('BUFFERED');
    const { router, api } = setup({ 'a.md': 'L1\nL2' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md', lineNumber: 2 }
    });
    expect(response.result).toEqual({ success: true, line: 2, mode: 'replace' });
    expect(api.files.get('a.md')).toBe('L1\nBUFFERED');
  });

  it('at_line without content or a buffer is rejected', async () => {
    const { router } = setup({ 'a.md': 'L1' });
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'a.md' }
    });
    expect(response.error?.message).toBe('No content provided and no buffered content found');
  });

  it('at_line refuses image files', async () => {
    const { router } = setup({}, ['pic.png']);
    const response = await router.route({
      operation: 'edit',
      action: 'at_line',
      params: { path: 'pic.png', content: 'x' }
    });
    expect(response.error?.message).toBe('Cannot perform line-based edits on image files');
  });

  it('from_buffer without a buffer is rejected', async () => {
    const { router } = setup({ 'a.md': 'L1' });
    const response = await router.route({
      operation: 'edit',
      action: 'from_buffer',
      params: { path: 'a.md' }
    });
    expect(response.error?.message).toBe('No buffered content available');
  });

  it('from_buffer replaces the buffered search text with the buffered content', async () => {
    ContentBufferManager.getInstance().store('NEW', undefined, { searchText: 'old line' });
    const { router, api } = setup({ 'a.md': 'old line\nnext' });
    const response = await router.route({
      operation: 'edit',
      action: 'from_buffer',
      params: { path: 'a.md' }
    });
    expect(response.result).toEqual({
      content: [{ type: 'text', text: 'Successfully replaced exact match in a.md' }]
    });
    expect(api.files.get('a.md')).toBe('NEW\nnext');
  });

  it('an unknown action is rejected', async () => {
    const { router } = setup({ 'a.md': 'x' });
    const response = await router.route({ operation: 'edit', action: 'nope', params: { path: 'a.md' } });
    expect(response.error?.message).toBe('Unknown edit action: nope');
  });

  it('the path guard runs before the action is resolved', async () => {
    const { router } = setup();
    const response = await router.route({ operation: 'edit', action: 'nope', params: {} });
    expect(response.error?.message).toBe("edit.nope requires 'path' (string, missing).");
  });
});
