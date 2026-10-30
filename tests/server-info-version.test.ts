/**
 * system.info reported "Obsidian: 1.0.0" for every vault. getServerInfo read
 * app.appVersion, which Obsidian does not expose, and fell back to a
 * hard-coded '1.0.0'. The running version is the `apiVersion` export.
 */
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

jest.mock('obsidian', () => ({
  ...jest.requireActual('../tests/__mocks__/obsidian'),
  apiVersion: '1.13.4',
}));

describe('getServerInfo', () => {
  it('reports the running Obsidian version from apiVersion', () => {
    const api = new ObsidianAPI(new App());

    expect(api.getServerInfo().versions.obsidian).toBe('1.13.4');
  });
});
