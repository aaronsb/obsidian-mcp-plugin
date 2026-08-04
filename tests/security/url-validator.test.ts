/**
 * Outbound URL validation (ADR-109, issue #284).
 *
 * The encoding matrix is the point of these tests: a hostname string
 * comparison passes most of them and is exactly the implementation this
 * module must never regress into. WHATWG URL canonicalization plus address
 * parsing must survive decimal/octal/hex IPv4, IPv6 forms, mapped addresses,
 * and DNS names resolving into blocked ranges.
 *
 * DNS is the only thing mocked — it is an I/O boundary, and the tests assert
 * on what the validator does with the answers, not on resolution itself.
 */
import * as dns from 'dns';
import { validateOutboundUrl, isBlockedAddress, OutboundFetchError } from '../../src/security/url-validator';

const ENABLED = () => true;
const DISABLED = () => false;

const expectRefusal = async (url: string, code: string, isEnabled = ENABLED) => {
  await expect(validateOutboundUrl(url, isEnabled)).rejects.toMatchObject({
    name: 'OutboundFetchError',
    code
  });
};

describe('validateOutboundUrl', () => {
  describe('the master switch', () => {
    it('refuses everything when disabled, before touching the URL', async () => {
      await expectRefusal('https://example.com/', 'WEB_FETCH_DISABLED', DISABLED);
      await expectRefusal('not even a url', 'WEB_FETCH_DISABLED', DISABLED);
    });
  });

  describe('scheme and shape', () => {
    it('refuses non-http(s) schemes', async () => {
      await expectRefusal('file:///etc/passwd', 'BLOCKED_SCHEME');
      await expectRefusal('ftp://example.com/', 'BLOCKED_SCHEME');
      await expectRefusal('gopher://example.com/', 'BLOCKED_SCHEME');
    });

    it('refuses unparseable URLs', async () => {
      await expectRefusal('http://', 'INVALID_URL');
      await expectRefusal('nope', 'INVALID_URL');
    });
  });

  describe('IPv4 literal encodings (the canonicalization matrix)', () => {
    const loopbackEncodings = [
      'http://127.0.0.1/',
      'http://2130706433/',      // decimal
      'http://0x7f000001/',      // hex
      'http://017700000001/',    // octal
      'http://0x7f.0.0.1/',      // mixed
      'http://127.1/',           // shorthand
    ];
    it.each(loopbackEncodings)('refuses loopback as %s', async (url) => {
      await expectRefusal(url, 'BLOCKED_ADDRESS');
    });

    it('refuses RFC1918, link-local, metadata, CGNAT and 0.0.0.0', async () => {
      for (const url of [
        'http://10.0.0.1/',
        'http://172.16.0.1/',
        'http://172.31.255.255/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data/', // cloud metadata
        'http://100.64.0.1/',
        'http://0.0.0.0/',
      ]) {
        await expectRefusal(url, 'BLOCKED_ADDRESS');
      }
    });

    it('permits a public IPv4 literal', async () => {
      const target = await validateOutboundUrl('http://93.184.216.34/', ENABLED);
      expect(target.address).toBe('93.184.216.34');
      expect(target.family).toBe(4);
    });

    it('does not block public addresses adjacent to private ranges', async () => {
      await expect(validateOutboundUrl('http://172.32.0.1/', ENABLED)).resolves.toBeDefined();
      await expect(validateOutboundUrl('http://11.0.0.1/', ENABLED)).resolves.toBeDefined();
      await expect(validateOutboundUrl('http://9.9.9.9/', ENABLED)).resolves.toBeDefined();
    });
  });

  describe('IPv6 literals', () => {
    it('refuses loopback, unspecified, link-local and unique-local', async () => {
      for (const url of [
        'http://[::1]/',
        'http://[::]/',
        'http://[fe80::1]/',
        'http://[febf::1]/',   // still inside fe80::/10
        'http://[fc00::1]/',
        'http://[fd12:3456:789a::1]/',
      ]) {
        await expectRefusal(url, 'BLOCKED_ADDRESS');
      }
    });

    it('refuses IPv4-mapped and NAT64 forms of blocked IPv4 addresses', async () => {
      await expectRefusal('http://[::ffff:127.0.0.1]/', 'BLOCKED_ADDRESS');
      await expectRefusal('http://[::ffff:7f00:1]/', 'BLOCKED_ADDRESS');
      await expectRefusal('http://[::ffff:192.168.1.1]/', 'BLOCKED_ADDRESS');
      await expectRefusal('http://[64:ff9b::7f00:1]/', 'BLOCKED_ADDRESS');
    });

    it('permits a public IPv6 literal', async () => {
      const target = await validateOutboundUrl('http://[2606:2800:220:1:248:1893:25c8:1946]/', ENABLED);
      expect(target.family).toBe(6);
    });
  });

  describe('DNS names', () => {
    let lookupSpy: jest.SpyInstance;
    afterEach(() => lookupSpy?.mockRestore());

    const mockLookup = (records: { address: string; family: number }[]) => {
      lookupSpy = jest.spyOn(dns.promises, 'lookup')
        .mockResolvedValue(records as never);
    };

    it('permits a name resolving only to public addresses, pinning the first', async () => {
      mockLookup([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
      const target = await validateOutboundUrl('https://example.com/page', ENABLED);
      expect(target.address).toBe('93.184.216.34');
      expect(lookupSpy).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
    });

    it('refuses a name if ANY record lands in a blocked range', async () => {
      mockLookup([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }, // the rebinding trick
      ]);
      await expectRefusal('https://rebind.example/', 'BLOCKED_ADDRESS');
    });

    it('refuses a name resolving to an internal IPv6 address', async () => {
      mockLookup([{ address: 'fd00::1', family: 6 }]);
      await expectRefusal('https://internal.example/', 'BLOCKED_ADDRESS');
    });

    it('refuses on resolution failure and on empty answers', async () => {
      lookupSpy = jest.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
      await expectRefusal('https://nxdomain.example/', 'DNS_FAILURE');
      lookupSpy.mockRestore();
      mockLookup([]);
      await expectRefusal('https://empty.example/', 'DNS_FAILURE');
    });
  });
});

describe('isBlockedAddress', () => {
  it('refuses anything that is not an IP literal (fail closed)', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('is not fooled by an unparseable IPv6-ish string', () => {
    expect(isBlockedAddress('::1::2')).toBe(true);
  });
});

describe('OutboundFetchError', () => {
  it('carries a machine-readable code', () => {
    const err = new OutboundFetchError('msg', 'BLOCKED_ADDRESS');
    expect(err.code).toBe('BLOCKED_ADDRESS');
    expect(err).toBeInstanceOf(Error);
  });
});
