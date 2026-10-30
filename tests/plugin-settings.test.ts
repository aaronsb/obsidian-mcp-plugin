/**
 * Loading settings never shares objects with DEFAULT_SETTINGS.
 *
 * Object.assign({}, DEFAULT_SETTINGS, loaded) is shallow, so when data.json
 * lacked a key the loaded settings held the default's own object. The settings
 * UI mutates toolVisibility in place (live tool handlers hold it), so turning
 * system.execute on would write `true` into DEFAULT_SETTINGS itself, and every
 * later load in the session would start opted in.
 */
import { DEFAULT_SETTINGS, mergeLoadedSettings } from '../src/plugin-settings';
import { applyVisibilityToggle, isActionVisible } from '../src/tools/semantic-tools';

describe('mergeLoadedSettings', () => {
  it('toggling system.execute on leaves DEFAULT_SETTINGS.toolVisibility unchanged', () => {
    const settings = mergeLoadedSettings({});
    applyVisibilityToggle(settings.toolVisibility, 'system.execute', true);

    expect(DEFAULT_SETTINGS.toolVisibility).toEqual({});
    expect(isActionVisible(mergeLoadedSettings({}).toolVisibility, 'system', 'execute')).toBe(false);
  });

  it('copies a loaded toolVisibility rather than holding the loaded object', () => {
    const loaded = { toolVisibility: { 'system.execute': true } };
    const settings = mergeLoadedSettings(loaded);
    expect(settings.toolVisibility).toEqual({ 'system.execute': true });
    expect(settings.toolVisibility).not.toBe(loaded.toolVisibility);
  });

  it('gives every load its own nested defaults', () => {
    const a = mergeLoadedSettings(null);
    a.certificateConfig.enabled = true;
    a.commandExecutionAllowlist.push('editor:save-file');
    a.validation!.maxBatchSize = 1;

    expect(DEFAULT_SETTINGS.certificateConfig.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.commandExecutionAllowlist).toEqual([]);
    expect(DEFAULT_SETTINGS.validation!.maxBatchSize).toBe(100);
  });

  it('treats a non-object toolVisibility in data.json as empty', () => {
    const settings = mergeLoadedSettings({ toolVisibility: 'all' as unknown as Record<string, boolean> });
    expect(settings.toolVisibility).toEqual({});
  });

  it('coerces the security booleans and the allowlist from data.json', () => {
    const settings = mergeLoadedSettings({
      readOnlyMode: 'true' as unknown as boolean,
      notifyOnCommandExecution: 'no' as unknown as boolean,
      commandExecutionAllowlist: ['a:b', 7, 'a:b'] as unknown as string[],
    });
    expect(settings.readOnlyMode).toBe(false);
    expect(settings.notifyOnCommandExecution).toBe(true);
    expect(settings.commandExecutionAllowlist).toEqual(['a:b']);
  });
});
