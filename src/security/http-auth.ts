import { createHash, timingSafeEqual } from 'crypto';

/**
 * The HTTP auth decision, extracted from the express middleware so it can be
 * tested exhaustively.
 *
 * It was previously inline in MCPHttpServer.setupMiddleware, which meant the
 * only way to cover `dangerouslyDisableAuth` was to stand up a server — so it
 * had no tests at all, despite being the switch that decides whether anything
 * on the network can reach the vault.
 *
 * Pure: no express, no plugin, no I/O. Every branch is reachable from a plain
 * object.
 */

export type AuthDecision =
  | { allow: true; reason: 'preflight' | 'auth-disabled' | 'no-key-configured' | 'authenticated' }
  | { allow: false; status: 401; error: string; reason: 'missing-header' | 'bad-format' | 'bad-key' };

export interface AuthInput {
  method: string;
  authHeader?: string;
  /** The configured key. Empty/undefined means no key is configured. */
  apiKey?: string;
  /** settings.dangerouslyDisableAuth */
  authDisabled?: boolean;
}

/**
 * Constant-time secret comparison, independent of input length.
 *
 * A plain `===` short-circuits on the first differing byte, leaking a key prefix
 * through response timing. The server is loopback by default so the window is
 * small, but not zero once binding is widened, and the fix is free.
 *
 * Both sides are hashed to a fixed 32 bytes before comparing. An earlier version
 * compared the raw buffers and bailed early on a length mismatch, which still
 * did work proportional to the attacker's input — so it leaked the key's LENGTH
 * even though each individual comparison was constant-time. Hashing removes the
 * length signal entirely and lets timingSafeEqual see two equal-length buffers
 * always, so it can never throw.
 */
function secretsMatch(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export function authorizeRequest(input: AuthInput): AuthDecision {
  // CORS preflight carries no credentials by design.
  if (input.method === 'OPTIONS') {
    return { allow: true, reason: 'preflight' };
  }

  if (input.authDisabled === true) {
    return { allow: true, reason: 'auth-disabled' };
  }

  const apiKey = input.apiKey;
  if (!apiKey) {
    // Deliberate fail-open, retained for backward compatibility: a vault with no
    // configured key accepts unauthenticated requests. Contained by loopback
    // binding in the default configuration, and NOT contained if binding is
    // widened. Asserted in the tests so the behaviour is a recorded decision
    // rather than an accident.
    return { allow: true, reason: 'no-key-configured' };
  }

  if (!input.authHeader) {
    return { allow: false, status: 401, error: 'Authentication required', reason: 'missing-header' };
  }

  if (input.authHeader.startsWith('Bearer ')) {
    const token = input.authHeader.slice(7);
    return secretsMatch(token, apiKey)
      ? { allow: true, reason: 'authenticated' }
      : { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-key' };
  }

  if (input.authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(input.authHeader.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    // RFC 7617 requires the colon. Rejecting a credential without one also keeps
    // parity with the previous implementation, whose destructuring yielded
    // `password === undefined` and failed — without this guard, slice(-1 + 1)
    // would treat the ENTIRE decoded string as the password, widening the
    // accepted credential encodings for no reason.
    if (sep === -1) {
      return { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-format' };
    }
    // Only the password carries the key; the username is ignored, which is what
    // lets `curl -u anything:KEY` work. Slicing after the FIRST colon (rather
    // than splitting on every one) keeps a key that itself contains a colon.
    const password = decoded.slice(sep + 1);
    return secretsMatch(password, apiKey)
      ? { allow: true, reason: 'authenticated' }
      : { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-key' };
  }

  return { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-format' };
}
