/**
 * safeFetch redirect policy (ADR-109).
 *
 * The transport is injected so no sockets are involved; what these tests pin
 * is the control flow around it — that EVERY hop passes through the validator
 * (the reason this client exists instead of window.fetch, whose manual
 * redirect mode hides Location), that relative Locations resolve against the
 * current hop, and that the hop cap terminates loops.
 */
import { safeFetch, type HopTransport, type HopResponse } from '../../src/security/safe-fetch';

const ENABLED = () => true;

const page = (body: string): HopResponse => ({
  status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' }, body
});

const redirect = (location: string, status = 302): HopResponse => ({
  status, statusText: 'Found', headers: { location }, body: ''
});

/** Transport serving a scripted map of url -> response, recording hops. */
const scripted = (script: Record<string, HopResponse>) => {
  const hops: string[] = [];
  const transport: HopTransport = (target) => {
    const url = target.url.toString();
    hops.push(url);
    const res = script[url];
    if (!res) throw new Error(`unscripted url: ${url}`);
    return Promise.resolve(res);
  };
  return { transport, hops };
};

describe('safeFetch', () => {
  it('returns the terminal response and final URL after following redirects', async () => {
    const { transport, hops } = scripted({
      'http://93.184.216.34/a': redirect('http://93.184.216.34/b', 301),
      'http://93.184.216.34/b': page('<h1>done</h1>'),
    });
    const res = await safeFetch('http://93.184.216.34/a', ENABLED, transport);
    expect(res.body).toBe('<h1>done</h1>');
    expect(res.finalUrl).toBe('http://93.184.216.34/b');
    expect(res.status).toBe(200);
    expect(hops).toEqual(['http://93.184.216.34/a', 'http://93.184.216.34/b']);
  });

  it('resolves relative Location against the current hop', async () => {
    const { transport, hops } = scripted({
      'http://93.184.216.34/dir/a': redirect('../other'),
      'http://93.184.216.34/other': page('ok'),
    });
    await safeFetch('http://93.184.216.34/dir/a', ENABLED, transport);
    expect(hops[1]).toBe('http://93.184.216.34/other');
  });

  it('validates every hop: a redirect into a blocked address is refused', async () => {
    // First hop is public and fine; it redirects to loopback. The validator
    // must refuse the SECOND hop — this is the SSRF-via-redirect case a
    // follow-mode fetch would sail through.
    const { transport, hops } = scripted({
      'http://93.184.216.34/start': redirect('http://127.0.0.1:3001/mcp'),
    });
    await expect(safeFetch('http://93.184.216.34/start', ENABLED, transport))
      .rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    expect(hops).toEqual(['http://93.184.216.34/start']); // blocked hop never fetched
  });

  it('validates the initial URL before any request is made', async () => {
    const { transport, hops } = scripted({});
    await expect(safeFetch('http://192.168.1.1/admin', ENABLED, transport))
      .rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    expect(hops).toEqual([]);
  });

  it('refuses everything when the setting is off, without touching the network', async () => {
    const { transport, hops } = scripted({});
    await expect(safeFetch('http://93.184.216.34/', () => false, transport))
      .rejects.toMatchObject({ code: 'WEB_FETCH_DISABLED' });
    expect(hops).toEqual([]);
  });

  it('terminates a redirect loop at the hop cap', async () => {
    const { transport, hops } = scripted({
      'http://93.184.216.34/a': redirect('http://93.184.216.34/b'),
      'http://93.184.216.34/b': redirect('http://93.184.216.34/a'),
    });
    await expect(safeFetch('http://93.184.216.34/a', ENABLED, transport))
      .rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    expect(hops.length).toBe(6); // initial + 5 redirects
  });

  it('treats a 3xx without Location as a terminal response', async () => {
    const { transport } = scripted({
      'http://93.184.216.34/x': { status: 304, statusText: 'Not Modified', headers: {}, body: '' },
    });
    const res = await safeFetch('http://93.184.216.34/x', ENABLED, transport);
    expect(res.status).toBe(304);
  });
});
