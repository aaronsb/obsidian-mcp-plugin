import * as net from 'net';
import * as dns from 'dns';

/**
 * Outbound URL validation for system.fetch_web (ADR-109).
 *
 * One place decides whether an outbound URL is permitted, per the
 * one-enforcement-path constraint from ADR-108. The tool handler and the
 * redirect loop both call this; nothing decides inline.
 *
 * Canonicalization is delegated to WHATWG URL parsing, which normalizes
 * decimal (2130706433), octal (017700000001), and hex (0x7f000001) IPv4
 * encodings to dotted-quad before we ever compare — string matching against
 * the raw input is exactly the trap this module exists to avoid.
 */

export class OutboundFetchError extends Error {
	constructor(message: string, public code: string) {
		super(message);
		this.name = 'OutboundFetchError';
	}
}

/** A validated fetch target: the parsed URL plus the exact address the
 * connection must be pinned to. Pinning (via a custom `lookup`) is what closes
 * the DNS-rebinding check/fetch race: the socket goes to the address that was
 * validated, not to whatever a second resolution returns. */
export interface ValidatedTarget {
	url: URL;
	address: string;
	family: 4 | 6;
}

function isBlockedIPv4(ip: string): boolean {
	const octets = ip.split('.').map(Number);
	if (octets.length !== 4 || octets.some(o => Number.isNaN(o))) return true;
	const [a, b] = octets;
	if (a === 0) return true;                      // 0.0.0.0/8 "this network"
	if (a === 10) return true;                     // RFC1918
	if (a === 127) return true;                    // loopback
	if (a === 169 && b === 254) return true;       // link-local, incl. 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true;       // RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	return false;
}

/** Parse an IPv6 literal into its 8 16-bit groups. Returns null if malformed.
 * Handles '::' compression and an embedded dotted-quad tail. */
function parseIPv6Groups(ip: string): number[] | null {
	// Rewrite an embedded dotted-quad tail (::ffff:1.2.3.4) as two hex groups
	// so the rest of the function parses one uniform shape.
	const lastColon = ip.lastIndexOf(':');
	if (lastColon === -1) return null;
	if (ip.includes('.', lastColon)) {
		const octets = ip.slice(lastColon + 1).split('.').map(Number);
		if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) return null;
		const hi = ((octets[0] << 8) | octets[1]).toString(16);
		const lo = ((octets[2] << 8) | octets[3]).toString(16);
		ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
	}
	const parts = ip.split('::');
	if (parts.length > 2) return null;
	const parseChunk = (s: string): number[] | null => {
		if (s === '') return [];
		const groups: number[] = [];
		for (const g of s.split(':')) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
			groups.push(parseInt(g, 16));
		}
		return groups;
	};
	const left = parseChunk(parts[0]);
	const right = parts.length === 2 ? parseChunk(parts[1]) : [];
	if (left === null || right === null) return null;
	const fill = 8 - left.length - right.length;
	if (parts.length === 2 && fill < 0) return null;
	if (parts.length === 1 && fill !== 0) return null;
	return [...left, ...Array.from({ length: Math.max(fill, 0) }, () => 0), ...right];
}

function isBlockedIPv6(ip: string): boolean {
	const groups = parseIPv6Groups(ip);
	if (!groups) return true; // unparseable literal: refuse
	const allZeroTo = (n: number) => groups.slice(0, n).every(g => g === 0);
	// :: (unspecified) and ::1 (loopback)
	if (allZeroTo(7) && (groups[7] === 0 || groups[7] === 1)) return true;
	if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
	if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
	// IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d):
	// evaluate as the embedded IPv4 address.
	if (allZeroTo(5) && (groups[5] === 0xffff || groups[5] === 0)) {
		const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
		return isBlockedIPv4(v4);
	}
	// NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address the same way.
	if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
		const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
		return isBlockedIPv4(v4);
	}
	return false;
}

export function isBlockedAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) return isBlockedIPv4(address);
	if (family === 6) return isBlockedIPv6(address);
	return true; // not an IP literal at all: refuse (callers pass resolved addresses)
}

/**
 * Validate an outbound URL against ADR-109 policy.
 *
 * @param rawUrl - URL as supplied by the caller (or a redirect Location)
 * @param isEnabled - Live predicate for the enableWebFetch setting (ADR-108
 *   pattern: consulted per call, never snapshotted)
 * @returns The parsed URL and the exact validated address to pin the
 *   connection to
 * @throws OutboundFetchError when the fetch must be refused
 */
export async function validateOutboundUrl(rawUrl: string, isEnabled: () => boolean): Promise<ValidatedTarget> {
	if (!isEnabled()) {
		throw new OutboundFetchError(
			'Web fetch is disabled. Enable "Allow outbound web fetch" in the plugin\'s security settings to use system.fetch_web.',
			'WEB_FETCH_DISABLED'
		);
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new OutboundFetchError(`Invalid URL: ${rawUrl}`, 'INVALID_URL');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new OutboundFetchError(`Blocked scheme: ${url.protocol} (only http and https are allowed)`, 'BLOCKED_SCHEME');
	}

	// URL.hostname wraps IPv6 literals in brackets; strip for address checks.
	const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

	if (net.isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new OutboundFetchError(`Blocked address: ${hostname} (private, loopback, link-local and metadata ranges are not fetchable)`, 'BLOCKED_ADDRESS');
		}
		return { url, address: hostname, family: net.isIP(hostname) as 4 | 6 };
	}

	// DNS name: every record it resolves to must be permitted, and the
	// connection is then pinned to one validated address.
	let records: { address: string; family: number }[];
	try {
		records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new OutboundFetchError(`DNS resolution failed for ${hostname}`, 'DNS_FAILURE');
	}
	if (records.length === 0) {
		throw new OutboundFetchError(`DNS resolution returned no addresses for ${hostname}`, 'DNS_FAILURE');
	}
	for (const record of records) {
		if (isBlockedAddress(record.address)) {
			throw new OutboundFetchError(
				`Blocked address: ${hostname} resolves to ${record.address} (private, loopback, link-local and metadata ranges are not fetchable)`,
				'BLOCKED_ADDRESS'
			);
		}
	}
	return { url, address: records[0].address, family: records[0].family as 4 | 6 };
}
