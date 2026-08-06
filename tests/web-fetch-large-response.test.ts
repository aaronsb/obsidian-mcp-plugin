/**
 * Large fetch_web responses survive the limiter and format legibly (#293).
 *
 * Found in live testing: `http://github.com/` fetched fine, converted fine,
 * and rendered the single word "undefined". The payload lives in one key as
 * `[{type:'text', text:'…'}]`, the limiter could only accept or reject whole
 * keys, and the formatter stringified the resulting absence.
 *
 * Both halves are pinned here — the limiter must shorten rather than drop, and
 * the formatter must never present a missing body as content.
 */
import { limitResponse, DEFAULT_LIMITER_CONFIG } from '../src/utils/response-limiter';
import { formatWebFetch } from '../src/formatters/system';

/** The exact shape the fetch tool returns, sized past any sane budget. */
const webFetchResult = (bodyLength: number) => ({
  content: [{ type: 'text', text: 'A'.repeat(bodyLength) }]
});

describe('large fetch_web responses', () => {
  describe('the limiter', () => {
    it('shortens the oversized content key instead of dropping it', () => {
      const limited = limitResponse(webFetchResult(500_000)) as {
        content?: { type: string; text: string }[];
        _truncated?: boolean;
      };

      expect(limited.content).toBeDefined();
      expect(limited.content?.[0]?.text).toEqual(expect.any(String));
      expect(limited.content?.[0]?.text.length).toBeGreaterThan(0);
      expect(limited.content?.[0]?.text.length).toBeLessThan(500_000);
      expect(limited._truncated).toBe(true);
    });

    it('leaves a response that already fits completely untouched', () => {
      const small = webFetchResult(50);
      expect(limitResponse(small)).toEqual(small);
    });

    it('keeps later small keys instead of stopping at the first big one', () => {
      // Key order is priority-first, so a break would discard cheap
      // high-value fields that happen to follow a large one.
      const limited = limitResponse(
        { bulk: 'A'.repeat(100_000), path: 'notes/x.md' },
        { ...DEFAULT_LIMITER_CONFIG, maxTokens: 200 }
      ) as Record<string, unknown>;

      expect(limited.path).toBe('notes/x.md');
      expect(limited._truncated).toBe(true);
    });
  });

  describe('the formatter', () => {
    it('renders the real body for a large page that was shortened', () => {
      const limited = limitResponse(webFetchResult(500_000)) as { content?: unknown };
      const out = formatWebFetch(limited as Parameters<typeof formatWebFetch>[0]);

      expect(out).not.toContain('undefined');
      expect(out).toContain('AAAA');
    });

    it('says so plainly when the body is missing entirely', () => {
      // Defense in depth: if a future limiter change drops the key again, this
      // must read as an absence, not as page content.
      const out = formatWebFetch({ _truncated: true });
      expect(out).not.toContain('undefined');
      expect(out).toContain('no content returned');
    });

    it('flags truncation so an agent knows to paginate', () => {
      const out = formatWebFetch({ content: 'partial page', _truncated: true });
      expect(out).toContain('partial page');
      expect(out).toContain('maxLength');
    });

    it('does not flag truncation on a complete response', () => {
      expect(formatWebFetch({ content: 'whole page' })).not.toContain('shortened');
    });
  });
});
