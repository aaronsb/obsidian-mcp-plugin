/**
 * bases operation — router dispatch (#199 stage 2, operations/bases.ts).
 *
 * Drives the real SemanticRouter -> executeBasesOperation path extracted in
 * ADR-202 stage 2. Only the ObsidianAPI I/O boundary is stubbed, so the
 * dispatch and validation logic under test is the shipped one. There was no
 * router-level test for the bases operation before this extraction.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';
import { BaseYAML } from '../src/types/bases-yaml';

class MockObsidianAPI extends ObsidianAPI {
  public created: Array<{ path: string; config: BaseYAML }> = [];

  constructor(private bases: Map<string, BaseYAML>) {
    super({} as App);
  }

  async listBases() {
    return Array.from(this.bases.keys()).map((path) => ({ path, name: path, views: [] }));
  }

  async readBase(path: string) {
    const base = this.bases.get(path);
    if (!base) throw new Error(`Base not found: ${path}`);
    return base;
  }

  async createBase(path: string, config: BaseYAML) {
    this.created.push({ path, config });
    this.bases.set(path, config);
  }

  async queryBase(path: string, viewName?: string) {
    if (!this.bases.has(path)) throw new Error(`Base not found: ${path}`);
    return { path, viewName, rows: [] } as never;
  }

  async exportBase(path: string, format: 'csv' | 'json' | 'markdown', viewName?: string) {
    if (!this.bases.has(path)) throw new Error(`Base not found: ${path}`);
    return `exported:${path}:${format}:${viewName ?? ''}`;
  }
}

function router(bases: Map<string, BaseYAML> = new Map()): { router: SemanticRouter; api: MockObsidianAPI } {
  const api = new MockObsidianAPI(bases);
  return { router: new SemanticRouter(api, {} as App), api };
}

describe('bases operation dispatch (router -> operations/bases.ts)', () => {
  it('list returns all known bases', async () => {
    const { router: r } = router(new Map([['areas/work.base', {} as BaseYAML]]));
    const response = await r.route({ operation: 'bases', action: 'list', params: {} });
    expect(response.result).toEqual([{ path: 'areas/work.base', name: 'areas/work.base', views: [] }]);
  });

  it('read returns the requested base config', async () => {
    const config = { views: [{ name: 'default' }] } as unknown as BaseYAML;
    const { router: r } = router(new Map([['areas/work.base', config]]));
    const response = await r.route({ operation: 'bases', action: 'read', params: { path: 'areas/work.base' } });
    expect(response.result).toEqual(config);
  });

  it('read without a path throws before touching the API', async () => {
    const { router: r } = router();
    const response = await r.route({ operation: 'bases', action: 'read', params: {} });
    expect(response.error?.message).toBe('Path parameter is required for reading a base');
  });

  it('create stores the base and returns success', async () => {
    const { router: r, api } = router();
    const config = { views: [] } as unknown as BaseYAML;
    const response = await r.route({
      operation: 'bases',
      action: 'create',
      params: { path: 'areas/new.base', config }
    });
    expect(response.result).toEqual({ success: true, path: 'areas/new.base' });
    expect(api.created).toEqual([{ path: 'areas/new.base', config }]);
  });

  it('view queries the base with the given view name', async () => {
    const { router: r } = router(new Map([['areas/work.base', {} as BaseYAML]]));
    const response = await r.route({
      operation: 'bases',
      action: 'view',
      params: { path: 'areas/work.base', viewName: 'kanban' }
    });
    expect(response.result).toEqual({ path: 'areas/work.base', viewName: 'kanban', rows: [] });
  });

  it('export returns formatted data for the requested format', async () => {
    const { router: r } = router(new Map([['areas/work.base', {} as BaseYAML]]));
    const response = await r.route({
      operation: 'bases',
      action: 'export',
      params: { path: 'areas/work.base', format: 'csv' }
    });
    expect(response.result).toEqual({
      success: true,
      data: 'exported:areas/work.base:csv:',
      format: 'csv'
    });
  });

  it('an unknown action is rejected', async () => {
    const { router: r } = router();
    const response = await r.route({ operation: 'bases', action: 'nope', params: {} });
    expect(response.error?.message).toBe('Unknown bases action: nope');
  });
});
