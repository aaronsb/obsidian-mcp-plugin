/**
 * system operation — router dispatch (#199 stage 2, operations/system.ts).
 *
 * Characterization tests: written against the router before
 * executeSystemOperation moved out of router.ts, and kept unchanged across
 * the move. They drive the real SemanticRouter -> system handler path; only
 * the ObsidianAPI I/O boundary is stubbed. fetch_web runs the real fetch tool
 * with web fetch left disabled, so no request leaves the process. There was
 * no router-level test for the system operation before this extraction.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

class SystemAPI extends ObsidianAPI {
  constructor() {
    super({} as App);
  }

  getServerInfo(): any {
    return { ok: true, service: 'stub' };
  }

  getCommands(): any {
    return [{ id: 'editor:save-file', name: 'Save current file' }];
  }
}

function setup() {
  return new SemanticRouter(new SystemAPI());
}

describe('system operation dispatch (router -> operations/system.ts)', () => {
  it('info returns the server info', async () => {
    const response = await setup().route({ operation: 'system', action: 'info', params: {} });
    expect(response.result).toEqual({ ok: true, service: 'stub' });
  });

  it('commands returns the command list', async () => {
    const response = await setup().route({ operation: 'system', action: 'commands', params: {} });
    expect(response.result).toEqual([{ id: 'editor:save-file', name: 'Save current file' }]);
  });

  it('fetch_web runs the fetch tool, which refuses while web fetch is disabled', async () => {
    const response = await setup().route({
      operation: 'system',
      action: 'fetch_web',
      params: { url: 'https://example.com/' }
    });
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(response.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^Error fetching URL \[[A-Z_]+\]: /);
  });

  it('an unknown action is rejected', async () => {
    const response = await setup().route({ operation: 'system', action: 'nope', params: {} });
    expect(response.error?.message).toBe('Unknown system action: nope');
  });
});
