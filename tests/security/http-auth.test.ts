/**
 * HTTP auth — the switch that decides whether anything on the network reaches
 * the vault, and which had NO test coverage before this file.
 *
 * The logic was inline in MCPHttpServer.setupMiddleware, so covering it meant
 * standing up a server; it was therefore never covered at all. It now lives in
 * security/http-auth.ts as a pure function, and this exercises every branch —
 * including the two fail-open paths, which are asserted so they stay recorded
 * decisions rather than quietly becoming accidents.
 */
import { authorizeRequest } from '../../src/security/http-auth';

const KEY = 'super-secret-key-1234';

const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

describe('authorizeRequest', () => {
  describe('with a key configured (the default posture)', () => {
    it('accepts a matching Bearer token', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: `Bearer ${KEY}`, apiKey: KEY });
      expect(d).toEqual({ allow: true, reason: 'authenticated' });
    });

    it('rejects a wrong Bearer token', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: 'Bearer nope', apiKey: KEY });
      expect(d.allow).toBe(false);
      expect(d).toMatchObject({ status: 401, reason: 'bad-key' });
    });

    it('rejects a token that is a prefix of the key', () => {
      // Guards against a truncating or startsWith-style comparison.
      const d = authorizeRequest({
        method: 'POST', authHeader: `Bearer ${KEY.slice(0, 5)}`, apiKey: KEY,
      });
      expect(d.allow).toBe(false);
    });

    it('rejects a token with the key as a prefix', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: `Bearer ${KEY}extra`, apiKey: KEY });
      expect(d.allow).toBe(false);
    });

    it('rejects an empty Bearer token', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: 'Bearer ', apiKey: KEY });
      expect(d.allow).toBe(false);
    });

    it('rejects a missing Authorization header', () => {
      const d = authorizeRequest({ method: 'POST', apiKey: KEY });
      expect(d).toMatchObject({ allow: false, status: 401, reason: 'missing-header' });
    });

    it('rejects an unrecognised auth scheme', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: `Token ${KEY}`, apiKey: KEY });
      expect(d).toMatchObject({ allow: false, status: 401, reason: 'bad-format' });
    });

    it('accepts Basic auth with any username, since only the password carries the key', () => {
      expect(authorizeRequest({ method: 'POST', authHeader: basic('anything', KEY), apiKey: KEY }))
        .toEqual({ allow: true, reason: 'authenticated' });
      expect(authorizeRequest({ method: 'POST', authHeader: basic('', KEY), apiKey: KEY }))
        .toEqual({ allow: true, reason: 'authenticated' });
    });

    it('accepts a Basic password containing a colon', () => {
      // Splitting on every ':' rather than the first would truncate such a key.
      const colonKey = 'a:b:c';
      const d = authorizeRequest({
        method: 'POST', authHeader: basic('user', colonKey), apiKey: colonKey,
      });
      expect(d).toEqual({ allow: true, reason: 'authenticated' });
    });

    it('rejects a wrong Basic password', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: basic('user', 'wrong'), apiKey: KEY });
      expect(d).toMatchObject({ allow: false, reason: 'bad-key' });
    });

    it('rejects a Basic credential with no colon', () => {
      // RFC 7617 requires the colon. Also a parity guard: slicing after
      // indexOf(':') would, at -1, treat the ENTIRE decoded string as the
      // password and authenticate `Basic base64(KEY)` — which the previous
      // destructuring implementation rejected.
      const noColon = `Basic ${Buffer.from(KEY, 'utf8').toString('base64')}`;
      const d = authorizeRequest({ method: 'POST', authHeader: noColon, apiKey: KEY });
      expect(d).toMatchObject({ allow: false, status: 401, reason: 'bad-format' });
    });

    it('rejects malformed base64 rather than throwing', () => {
      const d = authorizeRequest({ method: 'POST', authHeader: 'Basic !!!not-base64!!!', apiKey: KEY });
      expect(d.allow).toBe(false);
    });
  });

  describe('CORS preflight', () => {
    it('is allowed without credentials', () => {
      const d = authorizeRequest({ method: 'OPTIONS', apiKey: KEY });
      expect(d).toEqual({ allow: true, reason: 'preflight' });
    });

    it('is allowed even when the key is wrong, since preflight carries none', () => {
      const d = authorizeRequest({ method: 'OPTIONS', authHeader: 'Bearer wrong', apiKey: KEY });
      expect(d.allow).toBe(true);
    });
  });

  /**
   * Both of these are fail-open. Asserted deliberately: the point is that they
   * are decisions with known blast radius, not oversights. If either changes,
   * that should be a decision too.
   */
  describe('fail-open paths', () => {
    it('dangerouslyDisableAuth allows an unauthenticated request', () => {
      const d = authorizeRequest({ method: 'POST', apiKey: KEY, authDisabled: true });
      expect(d).toEqual({ allow: true, reason: 'auth-disabled' });
    });

    it('dangerouslyDisableAuth overrides even a wrong key', () => {
      const d = authorizeRequest({
        method: 'POST', authHeader: 'Bearer wrong', apiKey: KEY, authDisabled: true,
      });
      expect(d.allow).toBe(true);
    });

    it('only `true` disables auth — a truthy-looking value must not', () => {
      // Guards against `if (settings.dangerouslyDisableAuth)` creeping back in:
      // a stray string from hand-edited data.json would silently disable auth.
      const d = authorizeRequest({
        method: 'POST', apiKey: KEY, authDisabled: 'yes' as unknown as boolean,
      });
      expect(d.allow).toBe(false);
    });

    it('an unset API key allows unauthenticated requests (backward compatibility)', () => {
      expect(authorizeRequest({ method: 'POST' }))
        .toEqual({ allow: true, reason: 'no-key-configured' });
      expect(authorizeRequest({ method: 'POST', apiKey: '' }))
        .toEqual({ allow: true, reason: 'no-key-configured' });
      // Contained by loopback binding in the default configuration; NOT contained
      // if binding is widened, which is the combination worth being loud about.
    });
  });

  /**
   * data.json is hand-editable and loadData() returns it verbatim, so the
   * booleans that gate security have to be normalised on load. Without that, the
   * predicate's `=== true` and the settings toggle's truthiness disagree: the
   * toggle renders ON while enforcement is off. main.ts coerces both in
   * loadSettings; this pins the reason.
   */
  describe('settings coercion (main.ts loadSettings)', () => {
    it('a non-boolean authDisabled must not disable auth', () => {
      for (const bad of ['true', 1, {}, []] as unknown[]) {
        const d = authorizeRequest({
          method: 'POST', apiKey: KEY, authDisabled: bad as boolean,
        });
        expect(d.allow).toBe(false);
      }
    });
  });

  describe('constant-time comparison', () => {
    it('does not throw on length mismatch', () => {
      // Both sides are hashed to a fixed width before comparing, so
      // timingSafeEqual always sees equal lengths and can never throw. An
      // earlier version compared raw buffers and bailed early on a length
      // mismatch, which leaked the key's LENGTH even though each comparison was
      // itself constant-time.
      expect(() => authorizeRequest({ method: 'POST', authHeader: 'Bearer x', apiKey: KEY }))
        .not.toThrow();
      expect(() => authorizeRequest({ method: 'POST', authHeader: `Bearer ${KEY}${KEY}`, apiKey: KEY }))
        .not.toThrow();
    });

    it('rejects keys of every wrong length without leaking via an exception', () => {
      for (const len of [0, 1, KEY.length - 1, KEY.length + 1, KEY.length * 4]) {
        const guess = 'x'.repeat(len);
        expect(authorizeRequest({ method: 'POST', authHeader: `Bearer ${guess}`, apiKey: KEY }).allow)
          .toBe(false);
      }
    });

    it('handles multi-byte characters without throwing', () => {
      const unicodeKey = 'ключ-🔐-key';
      expect(authorizeRequest({
        method: 'POST', authHeader: `Bearer ${unicodeKey}`, apiKey: unicodeKey,
      })).toEqual({ allow: true, reason: 'authenticated' });
      expect(() => authorizeRequest({
        method: 'POST', authHeader: 'Bearer ключ', apiKey: unicodeKey,
      })).not.toThrow();
    });
  });
});
