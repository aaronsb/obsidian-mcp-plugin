import { DataviewTool, isDataviewToolAvailable } from '../src/tools/dataview-tool';
import { PluginDetector } from '../src/utils/plugin-detector';
import { formatResponse } from '../src/formatters';

/**
 * Mock Obsidian App for testing
 */
class MockApp {
  plugins = {
    enabledPlugins: new Set<string>(),
    manifests: {} as Record<string, any>,
    plugins: {} as Record<string, any>
  };

  constructor(dataviewEnabled = false, dataviewApiReady = false) {
    if (dataviewEnabled) {
      this.plugins.enabledPlugins.add('dataview');
      this.plugins.manifests['dataview'] = { version: '0.5.64' };
      
      if (dataviewApiReady) {
        this.plugins.plugins['dataview'] = {
          manifest: { version: '0.5.64' },
          api: new MockDataviewAPI()
        };
      } else {
        this.plugins.plugins['dataview'] = {
          manifest: { version: '0.5.64' },
          api: null
        };
      }
    }
  }
}

/**
 * Mock Dataview API for testing
 */
class MockDataviewAPI {
  query(query: string) {
    // Mock DQL query execution. Dataview's real query() resolves to a Result
    // monad — { successful, value, error } — where value.values is a PLAIN
    // array (not a wrapped DataArray). The previous mock used the wrong flat +
    // wrapped shape, which is why CI stayed green while real Dataview broke (#216).
    if (query.includes('LIST')) {
      return {
        successful: true,
        value: {
          type: 'list',
          values: ['Note 1', 'Note 2', 'Note 3']
        }
      };
    }

    if (query.includes('TABLE')) {
      return {
        successful: true,
        value: {
          type: 'table',
          headers: ['Name', 'Created', 'Tags'],
          values: [
            ['Note 1', '2024-01-01', '#tag1'],
            ['Note 2', '2024-01-02', '#tag2']
          ]
        }
      };
    }

    throw new Error('Invalid query');
  }

  pages(source?: string) {
    const mockPage1 = {
      file: {
        path: 'Note1.md',
        name: 'Note1.md',
        size: 1024,
        ctime: new Date('2024-01-01'),
        mtime: new Date('2024-01-02'),
        tags: { array: () => ['#tag1', '#tag2'] },
        outlinks: { array: () => [] }
      },
      aliases: { array: () => [] },
      customField: 'value1',
      rating: 5
    };

    const mockPage2 = {
      file: {
        path: 'Note2.md',
        name: 'Note2.md',
        size: 2048,
        ctime: new Date('2024-01-03'),
        mtime: new Date('2024-01-04'),
        tags: { array: () => ['#tag3'] },
        outlinks: { array: () => [] }
      },
      aliases: { array: () => ['Alias1'] },
      customField: 'value2',
      rating: 3
    };

    return {
      length: 2,
      array: () => [mockPage1, mockPage2]
    };
  }

  page(path: string) {
    if (path === 'Note1.md') {
      return {
        file: {
          path: 'Note1.md',
          name: 'Note1.md',
          basename: 'Note1',
          extension: 'md',
          size: 1024,
          ctime: new Date('2024-01-01'),
          mtime: new Date('2024-01-02'),
          tags: { array: () => ['#tag1', '#tag2'] },
          outlinks: { array: () => ['Note2.md'] },
          inlinks: { array: () => [] },
          tasks: { array: () => [] },
          lists: { array: () => [] }
        },
        aliases: { array: () => [] },
        customField: 'test value',
        rating: 5,
        priority: 'high'
      };
    }
    return null;
  }
}

/**
 * Mock ObsidianAPI for testing
 */
class MockObsidianAPI {
  constructor(private app: MockApp) {}

  getApp() {
    return this.app;
  }
}

describe('Dataview Integration', () => {
  describe('PluginDetector', () => {
    test('should detect when Dataview is not installed', () => {
      const app = new MockApp(false);
      const detector = new PluginDetector(app as any);

      expect(detector.isPluginInstalled('dataview')).toBe(false);
      expect(detector.isPluginEnabled('dataview')).toBe(false);
      expect(detector.isDataviewAvailable()).toBe(false);
      expect(detector.isDataviewAPIReady()).toBe(false);
    });

    test('should detect when Dataview is installed but not enabled', () => {
      const app = new MockApp(false);
      app.plugins.manifests['dataview'] = { version: '0.5.64' };
      const detector = new PluginDetector(app as any);

      expect(detector.isPluginInstalled('dataview')).toBe(true);
      expect(detector.isPluginEnabled('dataview')).toBe(false);
      expect(detector.isDataviewAvailable()).toBe(false);
      expect(detector.isDataviewAPIReady()).toBe(false);
    });

    test('should detect when Dataview is enabled but API not ready', () => {
      const app = new MockApp(true, false);
      const detector = new PluginDetector(app as any);

      expect(detector.isPluginInstalled('dataview')).toBe(true);
      expect(detector.isPluginEnabled('dataview')).toBe(true);
      expect(detector.isDataviewAvailable()).toBe(true);
      expect(detector.isDataviewAPIReady()).toBe(false);
    });

    test('should detect when Dataview is fully available', () => {
      const app = new MockApp(true, true);
      const detector = new PluginDetector(app as any);

      expect(detector.isPluginInstalled('dataview')).toBe(true);
      expect(detector.isPluginEnabled('dataview')).toBe(true);
      expect(detector.isDataviewAvailable()).toBe(true);
      expect(detector.isDataviewAPIReady()).toBe(true);

      const status = detector.getDataviewStatus();
      expect(status.installed).toBe(true);
      expect(status.enabled).toBe(true);
      expect(status.apiReady).toBe(true);
      expect(status.version).toBe('0.5.64');
    });
  });

  describe('DataviewTool', () => {
    test('should report unavailable when Dataview is not ready', () => {
      const app = new MockApp(false);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      expect(tool.isAvailable()).toBe(false);

      const status = tool.getStatus();
      expect(status.installed).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.apiReady).toBe(false);
    });

    test('should report available when Dataview is ready', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      expect(tool.isAvailable()).toBe(true);

      const status = tool.getStatus();
      expect(status.installed).toBe(true);
      expect(status.enabled).toBe(true);
      expect(status.apiReady).toBe(true);
      expect(status.version).toBe('0.5.64');
    });

    test('should execute LIST queries', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.executeQuery('LIST FROM #tag') as any;

      expect(result.success).toBe(true);
      expect(result.query).toBe('LIST FROM #tag');
      expect(result.format).toBe('dql');
      expect(result.result.type).toBe('list');
      expect(result.result.values).toEqual(['Note 1', 'Note 2', 'Note 3']);
    });

    test('should execute TABLE queries', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.executeQuery('TABLE name, created FROM #tag') as any;

      expect(result.success).toBe(true);
      expect(result.result.type).toBe('table');
      expect(result.result.headers).toEqual(['Name', 'Created', 'Tags']);
      expect(result.result.values).toHaveLength(2);
    });

    test('should list pages with metadata', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.listPages() as any;

      expect(result.success).toBe(true);
      expect(result.source).toBe('all');
      expect(result.count).toBe(2);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].path).toBe('Note1.md');
      expect(result.pages[0].customField).toBe('value1');
      expect(result.pages[0].rating).toBe(5);
    });

    test('should get page metadata', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.getPageMetadata('Note1.md') as any;

      expect(result.success).toBe(true);
      expect(result.path).toBe('Note1.md');
      expect(result.metadata.file.path).toBe('Note1.md');
      expect(result.metadata.custom.customField).toBe('test value');
      expect(result.metadata.custom.rating).toBe(5);
      expect(result.metadata.custom.priority).toBe('high');
    });

    test('should serialize Luxon DateTime values from listPages without crashing', async () => {
      // Regression for #123 bug 2: Dataview emits Luxon DateTime objects
      // (toISO() returns string|null) and not native Date.toISOString().
      const luxonDate = (iso: string) => ({ toISO: () => iso });
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const dvApi = (app.plugins.plugins['dataview'] as any).api as MockDataviewAPI;
      dvApi.pages = (() => ({
        length: 1,
        array: () => [{
          file: {
            path: 'Luxon.md',
            name: 'Luxon.md',
            size: 42,
            ctime: luxonDate('2026-01-02T03:04:05.000Z'),
            mtime: luxonDate('2026-01-02T03:04:06.000Z'),
            tags: { array: () => [] },
            outlinks: { array: () => [] }
          },
          aliases: { array: () => [] }
        }]
      })) as any;

      const result = tool.listPages() as any;
      expect(result.success).toBe(true);
      expect(result.pages[0].created).toBe('2026-01-02T03:04:05.000Z');
      expect(result.pages[0].modified).toBe('2026-01-02T03:04:06.000Z');
    });

    test('should serialize Luxon DateTime values from getPageMetadata without crashing', async () => {
      // Regression for #123 bug 3
      const luxonDate = (iso: string) => ({ toISO: () => iso });
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const dvApi = (app.plugins.plugins['dataview'] as any).api as MockDataviewAPI;
      dvApi.page = (path: string) => path === 'Luxon.md' ? {
        file: {
          path: 'Luxon.md',
          name: 'Luxon.md',
          basename: 'Luxon',
          extension: 'md',
          size: 42,
          ctime: luxonDate('2026-01-02T03:04:05.000Z'),
          mtime: luxonDate('2026-01-02T03:04:06.000Z'),
          tags: { array: () => [] },
          outlinks: { array: () => [] },
          inlinks: { array: () => [] },
          tasks: { array: () => [] },
          lists: { array: () => [] }
        },
        aliases: { array: () => [] }
      } as any : null;

      const result = tool.getPageMetadata('Luxon.md') as any;
      expect(result.success).toBe(true);
      expect(result.metadata.file.created).toBe('2026-01-02T03:04:05.000Z');
      expect(result.metadata.file.modified).toBe('2026-01-02T03:04:06.000Z');
    });

    test('should propagate Dataview-internal query failures to outer envelope', async () => {
      // Regression for #115 / #123 bug 1: Dataview returns
      //   {successful: false, error: "..."}
      // when a query is malformed instead of throwing. The tool used to
      // hard-code success:true regardless, hiding the real error.
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const dvApi = (app.plugins.plugins['dataview'] as any).api as MockDataviewAPI;
      // A failed Dataview query resolves the Result monad with no `value`,
      // only `{ successful: false, error }`.
      dvApi.query = (() => ({
        successful: false,
        error: 'No field "nonexistent" on this page'
      })) as any;

      const result = await tool.executeQuery('TABLE nonexistent FROM ""') as any;
      expect(result.success).toBe(false);
      expect(result.error).toBe('No field "nonexistent" on this page');
    });

    test('should validate queries', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const validResult = await tool.validateQuery('LIST FROM #tag') as any;
      expect(validResult.valid).toBe(true);
      expect(validResult.queryType).toBe('LIST');

      const invalidResult = await tool.validateQuery('INVALID QUERY') as any;
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.error).toContain('Query must start with one of');
    });
  });

  // #216: the formatted (non-raw) output is what MCP clients see by default.
  // These exercise the full producer → formatResponse() path that was broken,
  // not just the raw envelope (which already worked).
  describe('Formatted output (#216)', () => {
    test('dataview.query LIST renders results, not "UNKNOWN"/"No results found"', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const queryResult = await tool.executeQuery('LIST FROM #tag');
      const output = formatResponse('dataview', 'query', queryResult, false);

      expect(output).toContain('Dataview: LIST');
      expect(output).not.toContain('UNKNOWN');
      expect(output).not.toContain('No results found');
      expect(output).toContain('Note 1');
    });

    test('dataview.query TABLE renders its rows', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const queryResult = await tool.executeQuery('TABLE name FROM #tag');
      const output = formatResponse('dataview', 'query', queryResult, false);

      expect(output).toContain('Dataview: TABLE');
      expect(output).not.toContain('No results found');
      expect(output).toContain('Note 1');
    });

    test('dataview.status renders "available" when the plugin is ready', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const output = formatResponse('dataview', 'status', tool.getStatus(), false);

      expect(output).toContain('✓ Dataview plugin is available');
      expect(output).not.toContain('✗ Dataview plugin is not available');
      expect(output).toContain('0.5.64');
    });
  });

  describe('Tool Availability Detection', () => {
    test('should detect when Dataview tool is not available', () => {
      const app = new MockApp(false);
      const api = new MockObsidianAPI(app);

      expect(isDataviewToolAvailable(api as any)).toBe(false);
    });

    test('should detect when Dataview tool is available', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);

      expect(isDataviewToolAvailable(api as any)).toBe(true);
    });
  });
});