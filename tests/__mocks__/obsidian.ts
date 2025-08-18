// Mock Obsidian API for testing

export abstract class TAbstractFile {
  path!: string;
  name!: string;
}

export class TFile extends TAbstractFile {
  extension!: string;
}

export class App {
  vault: Vault;
  workspace: Workspace;

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
  }
}

export class Vault {
  getName(): string {
    return 'test-vault';
  }

  getRoot(): any {
    return {
      children: []
    };
  }

  getAbstractFileByPath(path: string): any {
    return null;
  }

  read(file: any): Promise<string> {
    return Promise.resolve('test content');
  }

  readBinary(file: any): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }
}

export class Workspace {
  getActiveFile(): any {
    return {
      name: 'test-file.md',
      path: 'test-file.md',
      stat: { mtime: Date.now() }
    };
  }
}

export class Plugin {
  app: App;
  settings: any = {};

  constructor(app: App, manifest: any) {
    this.app = app;
  }

  addSettingTab(tab: any): void {}
  addCommand(command: any): void {}
  addStatusBarItem(): any {
    return {
      setText: jest.fn()
    };
  }
  loadData(): Promise<any> {
    return Promise.resolve({});
  }
  saveData(data: any): Promise<void> {
    return Promise.resolve();
  }
}

export class PluginSettingTab {
  constructor(app: App, plugin: Plugin) {}
}

export class Setting {
  constructor(containerEl: any) {}
  setName(name: string) { return this; }
  setDesc(desc: string) { return this; }
  addToggle(cb: any) { return this; }
  addText(cb: any) { return this; }
}

export function normalizePath(path: string): string {
  // Simple normalization for testing
  return path.replace(/\\/g, '/');
}

// Minimal implementation of Obsidian's getAllTags utility for tests
// Accepts a metadata cache-like object and returns a flat list of tags with leading '#'
export function getAllTags(cache: any): string[] {
  if (!cache) return [];
  const out = new Set<string>();

  // From cache.tags: [{ tag: '#foo' }, { tag: '#foo/bar' }]
  if (Array.isArray(cache.tags)) {
    for (const t of cache.tags) {
      const raw = typeof t === 'string' ? t : t?.tag;
      if (!raw) continue;
      const norm = raw.startsWith('#') ? raw : `#${raw}`;
      out.add(norm);
    }
  }

  // From frontmatter.tags: 'foo', ['foo', 'bar'], or ['#foo/bar']
  const fmTags = cache.frontmatter?.tags;
  if (fmTags) {
    const list = Array.isArray(fmTags) ? fmTags : [fmTags];
    for (const rawItem of list) {
      if (!rawItem) continue;
      const raw = String(rawItem).trim();
      const norm = raw.startsWith('#') ? raw : `#${raw}`;
      out.add(norm);
    }
  }

  return Array.from(out);
}