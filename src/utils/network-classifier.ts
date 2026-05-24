/**
 * ADR-107: Network exposure modes as a classified state machine.
 *
 * Pure functions consumed by server-bind code, settings UI, and the
 * MCP `initialize` instructions injector — single source of truth for
 * "how exposed is the current network configuration?"
 */

export type BindMode = 'loopback' | 'all' | 'custom';

export type Protocol = 'http' | 'https';

export type CertSource = 'self' | 'user';

export type ResolvedBind = 'loopback' | 'all' | 'custom-loopback' | 'custom-other';

export interface NetworkState {
  protocol: Protocol;
  bind: ResolvedBind;
  certSource: CertSource;
}

export type VerdictClass = 'ok' | 'warn' | 'jail';

export interface Verdict {
  class: VerdictClass;
  reason: string;
}

const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const WILDCARD_ALIASES = new Set(['0.0.0.0', '::']);
// 127.0.0.0/8 — only strict dotted-quad IPv4 in the loopback block, not
// arbitrary hostnames that happen to start with "127." (e.g. 127.evil.com).
const LOOPBACK_IPV4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_ALIASES.has(h)) return true;
  return LOOPBACK_IPV4_RE.test(h);
}

function isWildcardHost(host: string): boolean {
  return WILDCARD_ALIASES.has(host.trim());
}

/**
 * If the user typed a loopback alias or wildcard into the custom field,
 * collapse it to the corresponding explicit mode. Returns the canonical
 * mode + the host to persist (blank for non-custom).
 */
export function normalizeBindInput(
  mode: BindMode,
  customHost: string
): { mode: BindMode; customHost: string } {
  if (mode !== 'custom') return { mode, customHost: '' };
  const trimmed = customHost.trim();
  if (trimmed === '') return { mode: 'custom', customHost: '' };
  if (isLoopbackHost(trimmed)) return { mode: 'loopback', customHost: '' };
  if (isWildcardHost(trimmed)) return { mode: 'all', customHost: '' };
  return { mode: 'custom', customHost: trimmed };
}

/**
 * Resolve settings to the actual host string passed to server.listen().
 */
export function resolveListenHost(mode: BindMode, customHost: string): string {
  switch (mode) {
    case 'all':
      return '0.0.0.0';
    case 'custom': {
      const trimmed = customHost.trim();
      return trimmed === '' ? '127.0.0.1' : trimmed;
    }
    case 'loopback':
    default:
      return '127.0.0.1';
  }
}

/**
 * Resolve settings to the bind axis used by classify().
 * `custom` collapses to `custom-loopback` or `custom-other` based on
 * whether the typed host is a loopback alias.
 */
export function resolveBindAxis(mode: BindMode, customHost: string): ResolvedBind {
  if (mode === 'loopback') return 'loopback';
  if (mode === 'all') return 'all';
  const trimmed = customHost.trim();
  if (trimmed === '' || isLoopbackHost(trimmed)) return 'custom-loopback';
  return 'custom-other';
}

/**
 * The full classification table from ADR-107.
 */
export function classify(state: NetworkState): Verdict {
  const { protocol, bind, certSource } = state;

  if (protocol === 'http') {
    if (bind === 'loopback' || bind === 'custom-loopback') {
      return {
        class: 'ok',
        reason: 'HTTP on loopback — traffic never leaves this machine.'
      };
    }
    if (bind === 'all') {
      return {
        class: 'jail',
        reason:
          'HTTP bound to every interface. API key and vault content travel in cleartext to anyone on the network.'
      };
    }
    return {
      class: 'jail',
      reason:
        'HTTP bound to a non-loopback address. API key and vault content travel in cleartext on the wire.'
    };
  }

  // protocol === 'https'
  if (bind === 'loopback' || bind === 'custom-loopback') {
    return {
      class: 'ok',
      reason: 'HTTPS on loopback — self-signed certificate is fine here.'
    };
  }

  if (certSource === 'user') {
    return {
      class: 'ok',
      reason:
        bind === 'all'
          ? 'HTTPS on every interface with a user-supplied certificate — the intended public deployment.'
          : 'HTTPS on a custom interface with a user-supplied certificate — the intended LAN/remote deployment.'
    };
  }

  // self-signed on non-loopback
  return {
    class: 'warn',
    reason:
      bind === 'all'
        ? 'HTTPS on every interface with a self-signed certificate — encrypted but clients must trust-on-first-use.'
        : 'HTTPS on a custom interface with a self-signed certificate — encrypted but clients must trust-on-first-use.'
  };
}

/**
 * Convenience: build NetworkState from settings + classify in one call.
 */
export function classifyFromSettings(args: {
  httpsEnabled: boolean;
  bindMode: BindMode;
  customBindHost: string;
  userSuppliedCert: boolean;
}): Verdict {
  return classify({
    protocol: args.httpsEnabled ? 'https' : 'http',
    bind: resolveBindAxis(args.bindMode, args.customBindHost),
    certSource: args.userSuppliedCert ? 'user' : 'self'
  });
}

/**
 * The agent-visible warning copy injected into MCP initialize.instructions
 * when the verdict is `jail`. Returns null otherwise.
 */
export function agentInstructionsForVerdict(
  verdict: Verdict,
  resolvedHost: string,
  port: number
): string | null {
  if (verdict.class !== 'jail') return null;
  return [
    'SECURITY WARNING: This Obsidian MCP server is configured to serve vault contents',
    `over an unencrypted network interface (${resolvedHost}:${port}). The API key and all`,
    'document text travel in cleartext over the network. If the user did not intend this,',
    'advise them to reconfigure the plugin to use HTTPS or to bind to loopback (127.0.0.1) only.'
  ].join(' ');
}
