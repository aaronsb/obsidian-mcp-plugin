/**
 * ADR-203 — faithful-by-default content reads with char-budget pagination
 * and line bookends. Covers #133's intent + the large-raw guard.
 */
import { readFileWithFragments, READ_PAGE_CHARS } from '../src/utils/file-reader';
import { formatFileRead } from '../src/formatters/vault';
import { UniversalFragmentRetriever } from '../src/indexing/fragment-retriever';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

class MockAPI extends ObsidianAPI {
  files = new Map<string, string>();
  constructor() { super({} as App); }
  async getFile(path: string): Promise<any> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return { path, content, tags: ['#demo'], frontmatter: { title: 'T' } };
  }
}

const fr = () => new UniversalFragmentRetriever();

// A whitespace/structure-sensitive small file — the #133 fidelity case.
const TRICKY = '---\ntitle: T\n---\n\n# H\n\npara **b**\n\n```python\ndef f(x):\n    return x*2  # indented\n```\n\ttab-line   \n';

describe('vault.read fidelity & pagination (ADR-203)', () => {
  test('small file: whole verbatim source, byte-exact, not paginated, body not duplicated', async () => {
    const api = new MockAPI();
    api.files.set('s.md', TRICKY);
    const r: any = await readFileWithFragments(api, fr(), { path: 's.md' });

    expect(typeof r.content).toBe('string');
    expect(r.content).toBe(TRICKY);                       // exact bytes, no flatten
    expect(r.pagination.paginated).toBe(false);
    expect(r.pagination.totalLines).toBe(TRICKY.split('\n').length);
    // metadata must NOT carry a second copy of the body (ADR-203 §3)
    expect(JSON.stringify(r.metadata)).not.toContain('def f(x)');
  });

  test('round-trip: a substring taken from the read matches the file for edit.window', async () => {
    const api = new MockAPI();
    api.files.set('s.md', TRICKY);
    const r: any = await readFileWithFragments(api, fr(), { path: 's.md' });
    // The exact indented code line an editing agent would target:
    expect(r.content).toContain('    return x*2  # indented');
    expect(r.content.split('\n')).toContain('\ttab-line   ');
  });

  const big = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n');

  test('large file: default returns bookended page 1, not the whole dump', async () => {
    const api = new MockAPI();
    api.files.set('big.md', big);
    const r: any = await readFileWithFragments(api, fr(), { path: 'big.md' });

    expect(r.pagination.paginated).toBe(true);
    expect(r.pagination.page).toBe(1);
    expect(r.pagination.pageLineStart).toBe(1);
    expect(r.pagination.pageLineEnd).toBeLessThan(r.pagination.totalLines);
    expect(r.pagination.hasMore).toBe(true);
    expect(r.pagination.nextPage).toContain('page=2');
    // page content is bounded by the char budget (the agent-safety invariant)
    expect((r.content as string).length).toBeLessThanOrEqual(READ_PAGE_CHARS);
    // ...and is a verbatim contiguous prefix (line 1 present, exact)
    expect((r.content as string).split('\n')[0]).toBe('line 1 ' + 'x'.repeat(20));
  });

  test('large file: page 2 continues contiguously from page 1 (absolute line numbers)', async () => {
    const api = new MockAPI();
    api.files.set('big.md', big);
    const p1: any = await readFileWithFragments(api, fr(), { path: 'big.md', page: 1 });
    const p2: any = await readFileWithFragments(api, fr(), { path: 'big.md', page: 2 });

    expect(p2.pagination.pageLineStart).toBe(p1.pagination.pageLineEnd + 1);
    const firstLineOfP2 = `line ${p2.pagination.pageLineStart} ${'x'.repeat(20)}`;
    expect((p2.content as string).split('\n')[0]).toBe(firstLineOfP2);
  });

  test('large file: returnFullFile=true overrides to the entire verbatim file', async () => {
    const api = new MockAPI();
    api.files.set('big.md', big);
    const r: any = await readFileWithFragments(api, fr(), { path: 'big.md', returnFullFile: true });
    expect(r.content).toBe(big);
    expect(r.pagination.paginated).toBe(false);
    expect(r.warning).toMatch(/returnFullFile override/i);
  });

  test('page past EOF is reported, not an error', async () => {
    const api = new MockAPI();
    api.files.set('big.md', big);
    const r: any = await readFileWithFragments(api, fr(), { path: 'big.md', page: 9999 });
    expect(r.pagination.beyondEnd).toBe(true);
    expect(r.content).toBe('');
    expect(r.warning).toMatch(/past end of file/i);
  });

  test('fragment params still route to semantic fragments (unchanged)', async () => {
    const api = new MockAPI();
    api.files.set('big.md', big);
    const r: any = await readFileWithFragments(api, fr(), { path: 'big.md', maxFragments: 3 });
    expect(Array.isArray(r.content)).toBe(true);
    expect(r.fragmentMetadata).toBeDefined();
  });

  test('formatted (non-raw) default output is byte-faithful — no truncation, no fence corruption', () => {
    // The blocking #133 case: an agent reading the DEFAULT (raw:false)
    // formatted output must be able to lift a byte-exact edit.window oldText.
    const out = formatFileRead({
      path: 's.md', content: TRICKY,
      metadata: { totalLines: TRICKY.split('\n').length, bytes: TRICKY.length },
      pagination: { paginated: false, page: 1, pageLineStart: 1, pageLineEnd: TRICKY.split('\n').length, totalLines: TRICKY.split('\n').length, bytes: TRICKY.length, hasMore: false, nextPage: null },
    } as any);
    // Verbatim body present in full, including the inner ```python fence,
    // the indented code line, and the trailing-space + tab line.
    expect(out).toContain(TRICKY);
    expect(out).toContain('    return x*2  # indented');
    expect(out).toContain('\ttab-line   ');
    expect(out).not.toMatch(/more lines\)/); // no truncation marker
  });

  test('formatter renders paginated + edge shapes without the _Formatter error_ crash', () => {
    const out2 = formatFileRead({
      path: 'big.md', content: 'line 1 ...\nline 2 ...',
      metadata: { totalLines: 4000, bytes: 90000 },
      pagination: { paginated: true, page: 1, pageLineStart: 1, pageLineEnd: 1800, totalLines: 4000, bytes: 90000, hasMore: true, nextPage: "vault.read(path='big.md', page=2)" },
      warning: 'Large file …',
    } as any);
    expect(out2).toContain('Pagination');
    expect(out2).toContain('page=2');
    expect(out2).not.toContain('Formatter error');
    // non-text passthrough must not crash
    expect(() => formatFileRead({ path: 'x.bin', content: { binary: true } } as any)).not.toThrow();
  });
});
