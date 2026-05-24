import {
  classify,
  classifyFromSettings,
  resolveListenHost,
  resolveBindAxis,
  normalizeBindInput,
  agentInstructionsForVerdict,
  NetworkState
} from '../src/utils/network-classifier';

describe('classify() — 9-cell ADR-107 table', () => {
  const cases: Array<{ name: string; state: NetworkState; expected: 'ok' | 'warn' | 'jail' }> = [
    { name: '1: http + loopback',            state: { protocol: 'http',  bind: 'loopback',            certSource: 'self' }, expected: 'ok'   },
    { name: '2: http + custom-other',        state: { protocol: 'http',  bind: 'custom-other',        certSource: 'self' }, expected: 'jail' },
    { name: '3: http + all',                 state: { protocol: 'http',  bind: 'all',                 certSource: 'self' }, expected: 'jail' },
    { name: '4: https + loopback + self',    state: { protocol: 'https', bind: 'loopback',            certSource: 'self' }, expected: 'ok'   },
    { name: '5: https + loopback + user',    state: { protocol: 'https', bind: 'loopback',            certSource: 'user' }, expected: 'ok'   },
    { name: '6: https + custom-other + self',state: { protocol: 'https', bind: 'custom-other',        certSource: 'self' }, expected: 'warn' },
    { name: '7: https + custom-other + user',state: { protocol: 'https', bind: 'custom-other',        certSource: 'user' }, expected: 'ok'   },
    { name: '8: https + all + self',         state: { protocol: 'https', bind: 'all',                 certSource: 'self' }, expected: 'warn' },
    { name: '9: https + all + user',         state: { protocol: 'https', bind: 'all',                 certSource: 'user' }, expected: 'ok'   }
  ];

  for (const c of cases) {
    test(c.name, () => {
      const v = classify(c.state);
      expect(v.class).toBe(c.expected);
      expect(v.reason).toBeTruthy();
    });
  }

  test('custom-loopback under http classifies as ok (not jail)', () => {
    expect(classify({ protocol: 'http', bind: 'custom-loopback', certSource: 'self' }).class).toBe('ok');
  });

  test('custom-loopback under https + self classifies as ok (not warn)', () => {
    expect(classify({ protocol: 'https', bind: 'custom-loopback', certSource: 'self' }).class).toBe('ok');
  });
});

describe('normalizeBindInput()', () => {
  test.each([
    ['127.0.0.1',         'loopback'],
    ['localhost',         'loopback'],
    ['LOCALHOST',         'loopback'],
    ['::1',               'loopback'],
    ['::ffff:127.0.0.1',  'loopback'],
    ['127.0.0.99',        'loopback'],
    ['127.255.255.254',   'loopback'],
    ['  127.0.0.1  ',     'loopback']
  ])('"%s" collapses to loopback mode', (input, expectedMode) => {
    const out = normalizeBindInput('custom', input);
    expect(out.mode).toBe(expectedMode);
    expect(out.customHost).toBe('');
  });

  test.each([
    '127.evil.com',
    '127.0.0.1.attacker.tld',
    '127.300.0.1',
    '1270.0.0.1'
  ])('"%s" does NOT collapse to loopback (hostile/invalid)', (input) => {
    const out = normalizeBindInput('custom', input);
    expect(out.mode).toBe('custom');
    expect(out.customHost).toBe(input);
  });

  test.each([
    ['0.0.0.0',  'all'],
    ['::',       'all'],
    ['  0.0.0.0', 'all']
  ])('"%s" collapses to all mode', (input, expectedMode) => {
    const out = normalizeBindInput('custom', input);
    expect(out.mode).toBe(expectedMode);
    expect(out.customHost).toBe('');
  });

  test('arbitrary LAN address stays custom and is trimmed', () => {
    const out = normalizeBindInput('custom', '  192.168.1.50  ');
    expect(out.mode).toBe('custom');
    expect(out.customHost).toBe('192.168.1.50');
  });

  test('empty custom stays custom with empty host', () => {
    expect(normalizeBindInput('custom', '')).toEqual({ mode: 'custom', customHost: '' });
    expect(normalizeBindInput('custom', '   ')).toEqual({ mode: 'custom', customHost: '' });
  });

  test('non-custom modes blank the customHost', () => {
    expect(normalizeBindInput('loopback', '192.168.1.5')).toEqual({ mode: 'loopback', customHost: '' });
    expect(normalizeBindInput('all', '192.168.1.5')).toEqual({ mode: 'all', customHost: '' });
  });
});

describe('resolveListenHost()', () => {
  test('loopback → 127.0.0.1', () => {
    expect(resolveListenHost('loopback', '')).toBe('127.0.0.1');
  });

  test('all → 0.0.0.0', () => {
    expect(resolveListenHost('all', '')).toBe('0.0.0.0');
  });

  test('custom → trimmed customHost', () => {
    expect(resolveListenHost('custom', '  192.168.1.50  ')).toBe('192.168.1.50');
  });

  test('custom with empty host falls back to loopback (defensive)', () => {
    expect(resolveListenHost('custom', '')).toBe('127.0.0.1');
    expect(resolveListenHost('custom', '   ')).toBe('127.0.0.1');
  });
});

describe('resolveBindAxis()', () => {
  test('loopback mode → loopback axis', () => {
    expect(resolveBindAxis('loopback', '')).toBe('loopback');
  });

  test('all mode → all axis', () => {
    expect(resolveBindAxis('all', '')).toBe('all');
  });

  test('custom with empty host → custom-loopback (defensive)', () => {
    expect(resolveBindAxis('custom', '')).toBe('custom-loopback');
  });

  test('custom with loopback alias → custom-loopback', () => {
    expect(resolveBindAxis('custom', '127.0.0.1')).toBe('custom-loopback');
    expect(resolveBindAxis('custom', 'localhost')).toBe('custom-loopback');
  });

  test('custom with LAN address → custom-other', () => {
    expect(resolveBindAxis('custom', '192.168.1.50')).toBe('custom-other');
  });
});

describe('classifyFromSettings()', () => {
  test('default install (http + loopback) → ok', () => {
    const v = classifyFromSettings({
      httpsEnabled: false,
      bindMode: 'loopback',
      customBindHost: '',
      userSuppliedCert: false
    });
    expect(v.class).toBe('ok');
  });

  test('http + all → jail', () => {
    const v = classifyFromSettings({
      httpsEnabled: false,
      bindMode: 'all',
      customBindHost: '',
      userSuppliedCert: false
    });
    expect(v.class).toBe('jail');
  });

  test('https + all + self-signed → warn', () => {
    const v = classifyFromSettings({
      httpsEnabled: true,
      bindMode: 'all',
      customBindHost: '',
      userSuppliedCert: false
    });
    expect(v.class).toBe('warn');
  });

  test('https + all + user cert → ok', () => {
    const v = classifyFromSettings({
      httpsEnabled: true,
      bindMode: 'all',
      customBindHost: '',
      userSuppliedCert: true
    });
    expect(v.class).toBe('ok');
  });
});

describe('agentInstructionsForVerdict()', () => {
  test('returns null for ok', () => {
    expect(agentInstructionsForVerdict({ class: 'ok', reason: 'x' }, '127.0.0.1', 3001)).toBeNull();
  });

  test('returns null for warn', () => {
    expect(agentInstructionsForVerdict({ class: 'warn', reason: 'x' }, '0.0.0.0', 3443)).toBeNull();
  });

  test('returns warning string for jail, includes host and port', () => {
    const s = agentInstructionsForVerdict({ class: 'jail', reason: 'x' }, '0.0.0.0', 3001);
    expect(s).not.toBeNull();
    expect(s).toContain('SECURITY WARNING');
    expect(s).toContain('0.0.0.0:3001');
    expect(s).toContain('cleartext');
  });
});
