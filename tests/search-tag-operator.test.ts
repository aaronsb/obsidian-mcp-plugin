import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App, TFile } from 'obsidian';

// Helper to create a mock TFile with required fields
function makeFile(path: string): TFile {
  const f = Object.create(TFile.prototype);
  Object.assign(f, {
    path,
    name: path.split('/').pop()!,
    basename: path.split('/').pop()!.replace(/\.[^/.]+$/, ''),
    extension: path.split('.').pop() || 'md',
    stat: { size: 123, mtime: Date.now() }
  });
  return f as TFile;
}

// Create a minimal mock app for tag-based search
function makeMockApp(filesWithCaches: Array<{ file: TFile; cache: any }>): App {
  const files = filesWithCaches.map((x) => x.file);
  const cacheMap = new Map<string, any>(filesWithCaches.map(({ file, cache }) => [file.path, cache]));

  const mockApp: any = {
    vault: {
      getFiles: jest.fn(() => files),
    },
    metadataCache: {
      getFileCache: jest.fn((file: TFile) => cacheMap.get(file.path)),
    },
  };

  return mockApp as App;
}

describe('search tag: operator', () => {
  test('matches files with exact tag and hierarchical children (no leading #)', async () => {
    const f1 = makeFile('notes/alpha.md');
    const f2 = makeFile('notes/beta.md');
    const f3 = makeFile('notes/gamma.md');

    const app = makeMockApp([
      {
        file: f1,
        cache: {
          // content tags form
          tags: [{ tag: '#foo' }],
        },
      },
      {
        file: f2,
        cache: {
          // hierarchical child should match tag:foo
          tags: [{ tag: '#foo/bar' }],
        },
      },
      {
        file: f3,
        cache: {
          // different tag
          tags: [{ tag: '#bar' }],
        },
      },
    ]);

    const api = new ObsidianAPI(app);

    const res = await api.searchPaginated('tag:foo');
    const paths = res.results.map((r) => r.path).sort();

    expect(paths).toEqual(['notes/alpha.md', 'notes/beta.md']);
  });

  test('matches with leading # and frontmatter tags', async () => {
    const f1 = makeFile('notes/frontmatter.md');
    const f2 = makeFile('notes/other.md');

    const app = makeMockApp([
      {
        file: f1,
        cache: {
          frontmatter: {
            tags: ['foo', 'x/y'],
          },
        },
      },
      {
        file: f2,
        cache: {
          frontmatter: {
            tags: ['bar'],
          },
        },
      },
    ]);

    const api = new ObsidianAPI(app);

    const res1 = await api.searchPaginated('tag:#foo');
    expect(res1.results.map((r) => r.path)).toEqual(['notes/frontmatter.md']);

    const res2 = await api.searchPaginated('tag:x');
    expect(res2.results.map((r) => r.path)).toEqual(['notes/frontmatter.md']);
  });
});
