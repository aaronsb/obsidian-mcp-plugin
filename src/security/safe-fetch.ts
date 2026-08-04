import * as http from 'http';
import * as https from 'https';
import type { LookupFunction } from 'net';
import { validateOutboundUrl, OutboundFetchError, type ValidatedTarget } from './url-validator';

/**
 * Outbound HTTP client for system.fetch_web (ADR-109).
 *
 * Built on node's http/https rather than window.fetch for two reasons that are
 * both security controls:
 *
 * 1. Redirects. `window.fetch` with `redirect: 'manual'` returns a
 *    spec-mandated opaque-redirect response whose Location header is
 *    unreadable, so per-hop re-validation is impossible; `redirect: 'follow'`
 *    would follow unvalidated hops. Here each 3xx surfaces with real headers
 *    and the next hop goes back through the validator.
 *
 * 2. DNS pinning. The request's `lookup` is overridden to return the exact
 *    address the validator approved, closing the rebinding race between check
 *    and connect. TLS SNI and certificate verification still key off the
 *    hostname, so pinning does not weaken HTTPS.
 */

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface SafeFetchResponse {
	status: number;
	statusText: string;
	contentType: string;
	body: string;
	finalUrl: string;
}

/** The response headers safeFetch actually consults, typed without the
 * string|string[] union noise of IncomingHttpHeaders (node sends both named
 * fields as plain strings). */
export interface HopHeaders {
	location?: string;
	'content-type'?: string;
}

export interface HopResponse {
	status: number;
	statusText: string;
	headers: HopHeaders;
	body: string;
}

function requestOnce(target: ValidatedTarget): Promise<HopResponse> {
	return new Promise((resolve, reject) => {
		const { url, address, family } = target;
		const transport = url.protocol === 'https:' ? https : http;
		// Pin the connection to the validated address. The hostname still drives
		// Host header, SNI and certificate checks.
		const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
			if (options.all) {
				callback(null, [{ address, family }]);
			} else {
				(callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, address, family);
			}
		};
		const req = transport.request(url, {
			method: 'GET',
			lookup: pinnedLookup,
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
				'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
				// No compressed encodings: this client does not decompress.
				'Accept-Encoding': 'identity'
			},
			timeout: REQUEST_TIMEOUT_MS
		}, (res) => {
			const chunks: Buffer[] = [];
			let received = 0;
			res.on('data', (chunk: Buffer) => {
				received += chunk.length;
				if (received > MAX_RESPONSE_BYTES) {
					req.destroy();
					reject(new OutboundFetchError(`Response exceeded ${MAX_RESPONSE_BYTES / (1024 * 1024)}MB limit`, 'RESPONSE_TOO_LARGE'));
					return;
				}
				chunks.push(chunk);
			});
			res.on('end', () => {
				resolve({
					status: res.statusCode ?? 0,
					statusText: res.statusMessage ?? '',
					headers: {
						location: res.headers.location,
						'content-type': res.headers['content-type']
					},
					body: Buffer.concat(chunks).toString('utf-8')
				});
			});
			res.on('error', reject);
		});
		req.on('timeout', () => {
			req.destroy(new OutboundFetchError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`, 'TIMEOUT'));
		});
		req.on('error', (err) => {
			reject(err instanceof OutboundFetchError ? err : new OutboundFetchError(String(err instanceof Error ? err.message : err), 'NETWORK_ERROR'));
		});
		req.end();
	});
}

/** Test seam: hop transport is injectable so redirect/validation behavior can
 * be exercised without sockets. Production always uses requestOnce. */
export type HopTransport = (target: ValidatedTarget) => Promise<HopResponse>;

/**
 * Fetch a URL under ADR-109 policy: every hop (initial and each redirect) is
 * validated and the connection pinned to the validated address.
 *
 * @throws OutboundFetchError on refusal or network failure
 */
export async function safeFetch(
	rawUrl: string,
	isEnabled: () => boolean,
	transport: HopTransport = requestOnce
): Promise<SafeFetchResponse> {
	let current = rawUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const target = await validateOutboundUrl(current, isEnabled);
		const res = await transport(target);
		if (res.status >= 300 && res.status < 400 && res.headers.location) {
			// Resolve relative Locations against the current hop, then loop —
			// the next iteration re-validates the new target.
			current = new URL(res.headers.location, target.url).toString();
			continue;
		}
		return {
			status: res.status,
			statusText: res.statusText,
			contentType: res.headers['content-type'] ?? '',
			body: res.body,
			finalUrl: target.url.toString()
		};
	}
	throw new OutboundFetchError(`Too many redirects (limit ${MAX_REDIRECTS})`, 'TOO_MANY_REDIRECTS');
}
