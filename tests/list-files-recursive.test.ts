import { App, TFile, TFolder } from 'obsidian';
import { ObsidianAPI } from '../src/utils/obsidian-api';

// Regression coverage for issue #154 — vault.list(directory) returned an
// empty array for folders whose direct children were all subfolders.
// listFiles should recurse into descendant folders, matching the
// behavior of the root case (which uses vault.getAllLoadedFiles()).

function makeFile(path: string): TFile {
  const f = new TFile();
  f.path = path;
  f.name = path.split('/').pop()!;
  f.extension = 'md';
  return f;
}

function makeFolder(path: string, children: TFile[] | TFolder[] = []): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() || path;
  folder.children = children;
  return folder;
}

describe('ObsidianAPI.listFiles — folder-of-folders (#154)', () => {
  let api: ObsidianAPI;
  let mockApp: App;
  let allFiles: (TFile | TFolder)[];
  let lookup: Map<string, TFile | TFolder>;

  beforeEach(() => {
    // Vault layout:
    //   technical/
    //     ai_research/
    //       paper.md
    //     experiments/
    //       trial.md
    //       (no notes at technical/ level)
    const paper = makeFile('technical/ai_research/paper.md');
    const trial = makeFile('technical/experiments/trial.md');
    const aiResearch = makeFolder('technical/ai_research', [paper]);
    const experiments = makeFolder('technical/experiments', [trial]);
    const technical = makeFolder('technical', [aiResearch, experiments]);

    allFiles = [technical, aiResearch, experiments, paper, trial];
    lookup = new Map(allFiles.map(f => [f.path, f]));

    mockApp = new App();
    mockApp.vault.getAbstractFileByPath = (path: string) => lookup.get(path) ?? null;
    mockApp.vault.getAllLoadedFiles = () => allFiles;
    mockApp.vault.adapter = { basePath: '/mock' } as any;

    api = new ObsidianAPI(mockApp);
  });

  it('returns all descendant files when a folder contains only subfolders', async () => {
    const files = await api.listFiles('technical');
    expect(files).toEqual([
      'technical/ai_research/paper.md',
      'technical/experiments/trial.md',
    ]);
  });

  it('still recurses through nested subfolders', async () => {
    const deep = makeFile('technical/ai_research/sub/deep.md');
    const sub = makeFolder('technical/ai_research/sub', [deep]);
    const aiResearch = lookup.get('technical/ai_research') as TFolder;
    aiResearch.children = [...aiResearch.children, sub];
    allFiles.push(sub, deep);
    lookup.set(sub.path, sub);
    lookup.set(deep.path, deep);

    const files = await api.listFiles('technical');
    expect(files).toContain('technical/ai_research/sub/deep.md');
  });

  it('throws when the directory does not exist', () => {
    // Note: listFiles throws synchronously despite the Promise return type.
    // Preserving that behavior so existing callers' try/catch around the call
    // site keeps working unchanged.
    expect(() => api.listFiles('does-not-exist')).toThrow(/Directory not found/);
  });

  it('still returns the full vault when called without a directory', async () => {
    const files = await api.listFiles();
    // getAllLoadedFiles returns folders too — listFiles must filter to files.
    expect(files).toEqual([
      'technical/ai_research/paper.md',
      'technical/experiments/trial.md',
    ]);
  });
});

describe('ObsidianAPI.listFilesPaginated — recursive mode', () => {
  let api: ObsidianAPI;
  let mockApp: App;
  let lookup: Map<string, TFile | TFolder>;

  beforeEach(() => {
    // 5 files spread across nested subfolders so a page boundary lands mid-tree.
    const files = [
      makeFile('docs/a/one.md'),
      makeFile('docs/a/two.md'),
      makeFile('docs/b/three.md'),
      makeFile('docs/c/sub/four.md'),
      makeFile('docs/c/sub/five.md'),
    ];
    const a = makeFolder('docs/a', [files[0], files[1]]);
    const b = makeFolder('docs/b', [files[2]]);
    const sub = makeFolder('docs/c/sub', [files[3], files[4]]);
    const c = makeFolder('docs/c', [sub]);
    const docs = makeFolder('docs', [a, b, c]);

    const all = [docs, a, b, c, sub, ...files];
    lookup = new Map(all.map(f => [f.path, f]));

    mockApp = new App();
    mockApp.vault.getAbstractFileByPath = (path: string) => lookup.get(path) ?? null;
    mockApp.vault.getAllLoadedFiles = () => all;
    mockApp.vault.adapter = { basePath: '/mock' } as any;

    api = new ObsidianAPI(mockApp);
  });

  it('paginates over the recursive file set when recursive=true', async () => {
    const page1 = await api.listFilesPaginated('docs', 1, 2, true);
    expect(page1.totalFiles).toBe(5);
    expect(page1.totalPages).toBe(3);
    expect(page1.files).toHaveLength(2);
    // Every entry should be a TFile — folders are filtered out in recursive mode.
    expect(page1.files.every(f => f.type === 'file')).toBe(true);

    const page2 = await api.listFilesPaginated('docs', 2, 2, true);
    expect(page2.files).toHaveLength(2);
    // No overlap between consecutive pages.
    const seen = new Set(page1.files.map(f => f.path));
    expect(page2.files.every(f => !seen.has(f.path))).toBe(true);
  });

  it('paged universe matches the flat listFiles universe (agent contract)', async () => {
    // The Settings UI / formatter tells the agent "use page=2 pageSize=N to
    // continue". That hint only works if concatenating pages reproduces the
    // same total order that the non-paginated listFiles call returned.
    const flat = await api.listFiles('docs');

    const pageSize = 2;
    const collected: string[] = [];
    const total = (await api.listFilesPaginated('docs', 1, pageSize, true)).totalPages;
    for (let page = 1; page <= total; page++) {
      const slice = await api.listFilesPaginated('docs', page, pageSize, true);
      collected.push(...slice.files.map(f => f.path));
    }
    expect(collected).toEqual(flat);
  });

  it('preserves level-only behavior when recursive=false (default)', async () => {
    const result = await api.listFilesPaginated('docs', 1, 20, false);
    // docs/ has three subfolders directly; should see those, not the leaf files.
    expect(result.totalFiles).toBe(3);
    expect(result.files.every(f => f.type === 'folder')).toBe(true);
  });
});
