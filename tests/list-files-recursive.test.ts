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
