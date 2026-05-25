/**
 * Regression tests for #210 — vault.update with missing `content` wrote the
 * literal string "undefined" to files. The fix moved required-param checks
 * to the dispatch boundary so a malformed MCP call cannot reach a vault
 * sink with `String(undefined)`. These tests cover the corruption-class
 * cases (update/append/window) plus the path-only guards.
 *
 * Strategy: a mock API records every mutation. After a malformed call we
 * assert the call threw AND that no mutation was recorded — i.e. the guard
 * runs before any sink, not after.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

type Mutation =
  | { kind: 'update'; path: string; content: string }
  | { kind: 'append'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'create'; path: string; content: string };

class RecordingAPI extends ObsidianAPI {
  readonly mutations: Mutation[] = [];
  private files = new Map<string, string>([['existing.md', 'original']]);

  constructor() {
    super({} as App);
  }

  async getFile(path: string): Promise<any> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { content, path, type: 'text' };
  }

  async updateFile(path: string, content: string): Promise<any> {
    this.mutations.push({ kind: 'update', path, content });
    this.files.set(path, content);
    return { success: true, path };
  }

  async appendToFile(path: string, content: string): Promise<any> {
    this.mutations.push({ kind: 'append', path, content });
    const prev = this.files.get(path) ?? '';
    this.files.set(path, prev + content);
    return { success: true, path };
  }

  async deleteFile(path: string): Promise<any> {
    this.mutations.push({ kind: 'delete', path });
    this.files.delete(path);
    return { success: true, path };
  }

  async createFile(path: string, content: string): Promise<any> {
    this.mutations.push({ kind: 'create', path, content });
    this.files.set(path, content);
    return { success: true, path };
  }
}

describe('dispatch-level param guards (#210)', () => {
  let api: RecordingAPI;
  let router: SemanticRouter;

  beforeEach(() => {
    api = new RecordingAPI();
    router = new SemanticRouter(api);
  });

  // The exact corruption shape from #210: client omits `content` while
  // sending `mode`/`search`/`replacement` as if calling vault.patch. Before
  // the fix this wrote the 9-byte literal "undefined" to existing.md.
  test('vault.update without content rejects without touching the vault', async () => {
    const response = await router.route({
      operation: 'vault',
      action: 'update',
      params: {
        path: 'existing.md',
        mode: 'replace',
        search: 'foo',
        replacement: 'bar',
      },
    });

    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
    // Source of truth — file is untouched.
    expect((await api.getFile('existing.md')).content).toBe('original');
  });

  test('vault.update without path rejects', async () => {
    const response = await router.route({
      operation: 'vault',
      action: 'update',
      params: { content: 'whatever' },
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
  });

  test('vault.update with both path and content succeeds and returns path', async () => {
    const response: any = await router.route({
      operation: 'vault',
      action: 'update',
      params: { path: 'existing.md', content: 'new body' },
    });
    expect(response.result).toMatchObject({ success: true, path: 'existing.md' });
    expect(api.mutations).toEqual([
      { kind: 'update', path: 'existing.md', content: 'new body' },
    ]);
  });

  test('vault.delete without path rejects', async () => {
    const response = await router.route({
      operation: 'vault',
      action: 'delete',
      params: {},
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
  });

  test('vault.create without path rejects', async () => {
    const response = await router.route({
      operation: 'vault',
      action: 'create',
      params: { content: 'body' },
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
  });

  test('edit.append without content rejects without touching the vault', async () => {
    const response = await router.route({
      operation: 'edit',
      action: 'append',
      params: { path: 'existing.md' },
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
    expect((await api.getFile('existing.md')).content).toBe('original');
  });

  test('edit.window without oldText/newText rejects before searching the file', async () => {
    const response = await router.route({
      operation: 'edit',
      action: 'window',
      params: { path: 'existing.md' },
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
  });

  test('edit.* without path rejects before taking a file lock', async () => {
    const response = await router.route({
      operation: 'edit',
      action: 'append',
      params: { content: 'whatever' },
    });
    expect((response as any).error).toBeDefined();
    expect(api.mutations).toEqual([]);
  });

  // Belt-and-suspenders for the second fix in #210: even if a guard ever
  // misses, the response carries `path` so the formatter can't render
  // "Updated: undefined" to the user.
  test('updateFile success response includes path for the formatter', async () => {
    const result = await api.updateFile('existing.md', 'x');
    expect(result).toMatchObject({ success: true, path: 'existing.md' });
  });
});
