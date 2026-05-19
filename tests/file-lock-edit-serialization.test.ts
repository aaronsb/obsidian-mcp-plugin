/**
 * Regression for #139: parallel edit actions against the same file silently
 * clobbered each other (every call returned success, only one edit survived).
 *
 * Two layers:
 *  1. FileLockManager unit behaviour (same-path serialized, different-path
 *     concurrent, error-isolated, map drains).
 *  2. Router-level repro: a MockAPI whose appendToFile is a realistic
 *     read-modify-write with an await gap. Without serialization, three
 *     parallel edit.append calls lose updates; with the #139 fix all land.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { FileLockManager } from '../src/utils/file-lock';
import { App } from 'obsidian';

describe('FileLockManager (unit)', () => {
  const mgr = FileLockManager.getInstance();

  test('serializes critical sections for the same path', async () => {
    const events: string[] = [];
    const op = (tag: string) => mgr.withLock('same.md', async () => {
      events.push(`${tag}:start`);
      await new Promise(r => setTimeout(r, 5));
      events.push(`${tag}:end`);
    });
    await Promise.all([op('A'), op('B'), op('C')]);
    // No interleaving: each start is immediately followed by its own end.
    expect(events).toEqual([
      'A:start', 'A:end',
      'B:start', 'B:end',
      'C:start', 'C:end',
    ]);
  });

  test('different paths run concurrently', async () => {
    const order: string[] = [];
    const slow = mgr.withLock('x.md', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('x');
    });
    const fast = mgr.withLock('y.md', async () => {
      order.push('y');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['y', 'x']); // y not blocked behind x
  });

  test('a rejected holder does not break serialization for later waiters', async () => {
    const seen: string[] = [];
    const bad = mgr.withLock('z.md', async () => { throw new Error('boom'); });
    const good = mgr.withLock('z.md', async () => { seen.push('ran'); });
    await expect(bad).rejects.toThrow('boom');
    await good;
    expect(seen).toEqual(['ran']);
  });

  test('chain entries drain so the map does not grow unbounded', async () => {
    await mgr.withLock('drain-a.md', async () => {});
    await mgr.withLock('drain-b.md', async () => {});
    // allow the post-drain microtask cleanup to run
    await new Promise(r => setTimeout(r, 0));
    expect(mgr.activeLockCount()).toBe(0);
  });
});

/**
 * MockAPI.appendToFile mimics a read-modify-write with an await gap — the
 * exact shape that loses concurrent updates without a per-file lock.
 */
class MockAPI extends ObsidianAPI {
  files = new Map<string, string>([['_test.md', '# Test\n']]);

  constructor() {
    super({} as App);
  }

  async appendToFile(path: string, content: string): Promise<any> {
    const current = this.files.get(path) ?? '';
    // Yield: a competing append can read the same `current` here if the
    // edit handler is not serializing per file.
    await new Promise(r => setTimeout(r, 5));
    this.files.set(path, current + content);
    return { success: true, path };
  }
}

describe('edit.append parallel calls against one file (#139, router level)', () => {
  test('all three concurrent appends persist (no silent clobber)', async () => {
    const api = new MockAPI();

    // Fresh router per call — faithful to production (router is per-request;
    // FileLockManager is the process-wide singleton that actually serializes).
    const append = (line: string) =>
      new SemanticRouter(api).route({
        operation: 'edit',
        action: 'append',
        params: { path: '_test.md', content: line },
      });

    const results = await Promise.all([
      append('ALPHA\n'),
      append('BRAVO\n'),
      append('CHARLIE\n'),
    ]);

    // Every call still reports success...
    for (const r of results) {
      expect((r as any).error).toBeFalsy();
    }
    // ...and every edit actually landed (the #139 bug lost two of three).
    const final = api.files.get('_test.md')!;
    expect(final).toContain('ALPHA');
    expect(final).toContain('BRAVO');
    expect(final).toContain('CHARLIE');
    expect(final).toBe('# Test\nALPHA\nBRAVO\nCHARLIE\n');
  });

  test('edits to different files are not serialized against each other', async () => {
    const api = new MockAPI();
    api.files.set('other.md', '');

    const start = Date.now();
    await Promise.all([
      new SemanticRouter(api).route({ operation: 'edit', action: 'append', params: { path: '_test.md', content: 'A' } }),
      new SemanticRouter(api).route({ operation: 'edit', action: 'append', params: { path: 'other.md', content: 'B' } }),
    ]);
    // Two independent ~5ms ops in parallel should not take ~10ms+ serially.
    expect(Date.now() - start).toBeLessThan(40);
  });
});
