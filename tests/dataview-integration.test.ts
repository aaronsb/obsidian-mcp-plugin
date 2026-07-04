import { DataviewTool, isDataviewToolAvailable, normalizeListGroupByQuery } from '../src/tools/dataview-tool';
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

    // GROUP BY: Dataview nests rows under group wrappers, and the collections
    // are DataArrays (`.array()`), not plain arrays. Mocked faithfully so the
    // producer's group-unwrap + flatten is actually exercised (#220).
    if (query.includes('GROUP BY') && query.includes('TASK')) {
      return {
        successful: true,
        value: {
          type: 'task',
          values: {
            array: () => [
              { key: 'open', rows: { array: () => [
                { text: 'task one', completed: false, path: 'Note1.md' },
                { text: 'task two', completed: true, path: 'Note2.md' }
              ] } },
              { key: null, rows: { array: () => [
                { text: 'ungrouped task', completed: false, path: 'Note3.md' }
              ] } }
            ]
          }
        }
      };
    }

    if (query.includes('GROUP BY')) {
      // Faithful to real Dataview: a grouped LIST that references `rows` returns
      // list-pair group wrappers; one that does NOT collapses to bare group keys
      // (the rows are dropped from the query() payload). This is what makes the
      // normalizeListGroupByQuery injection observable (#220 live follow-up).
      if (!query.includes('rows')) {
        return {
          successful: true,
          value: {
            type: 'list',
            values: ['groupA', 'groupB']
          }
        };
      }
      return {
        successful: true,
        value: {
          type: 'list',
          values: {
            array: () => [
              { $widget: 'dataview:list-pair', key: 'groupA', value: { array: () => ['Note 1', 'Note 2'] } },
              { $widget: 'dataview:list-pair', key: null, value: { array: () => ['Note 3'] } }
            ]
          }
        }
      };
    }

    if (query.includes('LIST')) {
      return {
        successful: true,
        value: {
          type: 'list',
          values: ['Note 1', 'Note 2', 'Note 3']
        }
      };
    }

    if (query.includes('TABLE') && query.includes('mtime')) {
      // Rich TABLE: rows are DataArrays of cells; cells are a Link object and a
      // Luxon-style DateTime (toISO), not primitives (#220 cell rendering).
      return {
        successful: true,
        value: {
          type: 'table',
          headers: ['File', 'file.mtime'],
          values: [
            { array: () => [
              { path: 'Note1.md', display: 'Note1', type: 'file' },
              { toISO: () => '2026-01-02T03:04:05.000Z' }
            ] },
            { array: () => [
              { path: 'Note2.md' },
              { toISO: () => '2026-01-03T00:00:00.000Z' }
            ] }
          ]
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

  // #220: dataview.list / dataview.metadata non-raw output always rendered
  // "No results found" because their {count,pages} / {metadata} producer shapes
  // were force-cast into the {values} query formatter. These exercise the full
  // producer → formatResponse() path with the real Dataview producer shapes.
  describe('Formatted output (#220)', () => {
    test('dataview.list renders page paths and count, not "No results found"', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const output = formatResponse('dataview', 'list', tool.listPages('#tag'), false);

      expect(output).toContain('Dataview: Pages');
      expect(output).not.toContain('No results found');
      expect(output).toContain('Count');
      expect(output).toContain('Note1.md');
      expect(output).toContain('Note2.md');
    });

    test('dataview.metadata renders page metadata and frontmatter, not "No results found"', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const output = formatResponse('dataview', 'metadata', tool.getPageMetadata('Note1.md'), false);

      expect(output).toContain('Dataview: Metadata');
      expect(output).not.toContain('No results found');
      expect(output).toContain('Note1.md');
      // custom frontmatter fields surfaced
      expect(output).toContain('priority');
      expect(output).toContain('high');
    });

    test('dataview.list surfaces a producer failure instead of a false "No results found"', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const dvApi = (app.plugins.plugins['dataview'] as any).api as MockDataviewAPI;
      dvApi.pages = (() => { throw new Error('bad source'); }) as any;

      const output = formatResponse('dataview', 'list', tool.listPages('nonsense'), false);

      expect(output).toContain('Query failed');
      expect(output).toContain('bad source');
      expect(output).not.toContain('No results found');
    });

    test('dataview.metadata surfaces a page-not-found failure', () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      // page() returns null for an unknown path → producer returns {success:false, error}
      const output = formatResponse('dataview', 'metadata', tool.getPageMetadata('Missing.md'), false);

      expect(output).toContain('Dataview: Metadata');
      expect(output).toContain('Missing.md');
      expect(output).toContain('Page not found');
    });
  });

  // #220 (folded in): GROUP BY queries nest rows under group wrappers; the
  // list/task branches rendered the wrappers (or, for tasks, mangled them into
  // empty tasks) instead of the grouped rows. Driven end-to-end through
  // executeQuery → formatResponse with DataArray-wrapped fixtures.
  describe('GROUP BY formatted output (#220)', () => {
    test('LIST ... GROUP BY renders group keys and rows, not the list-pair wrapper', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.executeQuery('LIST rows.file.name FROM #tag GROUP BY group');
      const output = formatResponse('dataview', 'query', result, false);

      expect(output).toContain('Dataview: LIST');
      expect(output).not.toContain('No results found');
      expect(output).not.toContain('list-pair'); // wrapper not leaked
      expect(output).not.toContain('$widget');
      expect(output).toContain('groupA');
      expect(output).toContain('Note 1');
      expect(output).toContain('Note 2');
      expect(output).toContain('(no group)'); // null group key
      expect(output).toContain('Note 3');
    });

    test('TASK ... GROUP BY renders group keys and their tasks', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.executeQuery('TASK FROM #tag GROUP BY status');
      const output = formatResponse('dataview', 'query', result, false);

      expect(output).toContain('Dataview: TASK');
      expect(output).not.toContain('No results found');
      expect(output).toContain('open'); // group key
      expect(output).toContain('task one');
      expect(output).toContain('[x] task two'); // completed checkbox preserved
      expect(output).toContain('(no group)');
      expect(output).toContain('ungrouped task');
    });
  });

  // #220 (folded in, from the maintainer's comment): TABLE cells that are
  // Dataview Link / DateTime objects rendered as raw JSON / quoted ISO strings.
  describe('TABLE cell rendering (#220)', () => {
    test('Link cells collapse to display/path and dates render unquoted', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      const result = await tool.executeQuery('TABLE file.mtime FROM ""');
      const output = formatResponse('dataview', 'query', result, false);

      expect(output).toContain('Dataview: TABLE');
      // Link → display (first row) / path (second row), not raw JSON
      expect(output).not.toContain('{"path"');
      expect(output).toContain('Note1'); // display
      expect(output).toContain('Note2.md'); // path fallback
      // DateTime → bare ISO, no surrounding quotes
      expect(output).toContain('2026-01-02T03:04:05.000Z');
      expect(output).not.toContain('"2026-01-02T03:04:05.000Z"');
    });
  });

  // Live follow-up to #220 (found running 0.11.37 against Dataview 0.5.68):
  // Dataview's query() API drops grouped rows for an implicit `LIST ... GROUP BY`
  // (no `rows` reference), returning bare group keys. normalizeListGroupByQuery
  // injects a default `rows.file.link` output so proper groups come back.
  describe('implicit LIST ... GROUP BY row recovery', () => {
    test('injects rows.file.link only for a grouped LIST with no output expression', () => {
      // Implicit grouped LIST → augmented
      expect(normalizeListGroupByQuery('LIST FROM "x" GROUP BY file.folder'))
        .toBe('LIST rows.file.link FROM "x" GROUP BY file.folder');
      expect(normalizeListGroupByQuery('LIST GROUP BY status'))
        .toBe('LIST rows.file.link GROUP BY status');
      expect(normalizeListGroupByQuery('list from "x" group by y'))
        .toBe('LIST rows.file.link from "x" group by y');

      // Already has an output expression → unchanged
      expect(normalizeListGroupByQuery('LIST rows.file.name FROM "x" GROUP BY file.folder'))
        .toBe('LIST rows.file.name FROM "x" GROUP BY file.folder');
      // Not grouped → unchanged
      expect(normalizeListGroupByQuery('LIST FROM "x"'))
        .toBe('LIST FROM "x"');
      // Not a LIST → unchanged
      expect(normalizeListGroupByQuery('TABLE file.mtime FROM "x" GROUP BY file.folder'))
        .toBe('TABLE file.mtime FROM "x" GROUP BY file.folder');
      expect(normalizeListGroupByQuery('TASK FROM "x" GROUP BY status'))
        .toBe('TASK FROM "x" GROUP BY status');
    });

    test('an implicit grouped LIST renders grouped rows end-to-end, not bare keys', async () => {
      const app = new MockApp(true, true);
      const api = new MockObsidianAPI(app);
      const tool = new DataviewTool(api as any);

      // No `rows` in the user query; the faithful mock would return bare keys
      // without the injection. With it, proper {key, rows} groups come back.
      const result = await tool.executeQuery('LIST FROM #tag GROUP BY group');
      const output = formatResponse('dataview', 'query', result, false);

      expect(output).toContain('Dataview: LIST');
      expect(output).toContain('groupA');
      expect(output).toContain('Note 1'); // grouped row recovered
      expect(output).toContain('Note 2');
      expect(output).not.toContain('$widget');
    });
  });

  // Live follow-up: `TASK ... GROUP BY status` groups incomplete tasks under a
  // space-character key, which rendered as an empty bold header (`**** (n)`).
  describe('whitespace group key label', () => {
    test('a whitespace-only group key renders as (no group), not empty bold', () => {
      const result = {
        success: true,
        query: 'TASK FROM "x" GROUP BY status',
        format: 'dql',
        result: {
          type: 'task',
          values: [
            { key: ' ', rows: [{ text: 'incomplete task', completed: false, path: 'Note1.md' }] }
          ]
        },
        type: 'task'
      };

      const output = formatResponse('dataview', 'query', result, false);

      expect(output).toContain('(no group)');
      expect(output).toContain('incomplete task');
      expect(output).not.toContain('**** '); // no empty bold header
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