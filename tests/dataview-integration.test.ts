import { DataviewTool, isDataviewToolAvailable } from '../src/tools/dataview-tool';
import { PluginDetector } from '../src/utils/plugin-detector';

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
    // Mock DQL query execution
    if (query.includes('LIST')) {
      return {
        type: 'list',
        values: {
          array: () => ['Note 1', 'Note 2', 'Note 3']
        }
      };
    }
    
    if (query.includes('TABLE')) {
      return {
        type: 'table',
        headers: ['Name', 'Created', 'Tags'],
        values: {
          array: () => [
            { array: () => ['Note 1', '2024-01-01', '#tag1'] },
            { array: () => ['Note 2', '2024-01-02', '#tag2'] }
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