import { timingSafeEqual } from 'crypto';

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
 * Constant-time string comparison.
 *
 * A plain `===` short-circuits on the first differing byte, which leaks a key
 * prefix through response timing. The server is loopback by default so this is
 * a small window, but it is not zero when binding is widened, and the fix is
 * free.
 */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a leak, so
  // compare lengths separately and still run the full comparison.
  if (bufA.length !== bufB.length) {
    // Compare against itself to keep the work roughly constant, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
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
    // Only the password carries the key; the username is ignored, which is what
    // lets `curl -u anything:KEY` work.
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return secretsMatch(password, apiKey)
      ? { allow: true, reason: 'authenticated' }
      : { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-key' };
  }

  return { allow: false, status: 401, error: 'Invalid API key', reason: 'bad-format' };
}
