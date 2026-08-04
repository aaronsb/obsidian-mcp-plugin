/**
 * The fetch tool's default posture (ADR-109): absent or false enableWebFetch
 * means refusal. "Absent" is the important case — it is what every existing
 * install upgrades into, and what a fresh install starts as. If this test
 * breaks because someone made the default true, that is the decision being
 * reversed, not a test to update.
 */
import { fetchTool } from '../../src/tools/fetch';

const handlerResult = async (api: unknown) =>
  await fetchTool.handler(api, { url: 'https://example.com/' });

describe('fetchTool gate', () => {
  it('refuses when the api has no plugin reference (absent setting = off)', async () => {
    const result = await handlerResult({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('WEB_FETCH_DISABLED');
  });

  it('refuses when enableWebFetch is explicitly false', async () => {
    const result = await handlerResult({ plugin: { settings: { enableWebFetch: false } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('WEB_FETCH_DISABLED');
  });

  it('refuses when enableWebFetch is a truthy non-boolean (=== true, not truthiness)', async () => {
    const result = await handlerResult({ plugin: { settings: { enableWebFetch: 'true' } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('WEB_FETCH_DISABLED');
  });

  it('proceeds past the gate when enabled (fails later on the blocked test address)', async () => {
    // Enabled, but pointed at loopback: the refusal must now be the address
    // policy, proving the gate opened and the validator took over.
    const result = await fetchTool.handler(
      { plugin: { settings: { enableWebFetch: true } } },
      { url: 'http://127.0.0.1:3001/mcp' }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('BLOCKED_ADDRESS');
  });
});
