/**
 * Exhaustive read-only enforcement matrix.
 *
 * Derives the action list from getActionsForOperation() — the same source the
 * shipped tool schemas are built from — rather than a hand-written list, so a
 * newly added action appears here automatically and FAILS until it is
 * explicitly classified as read or write. That fail-closed property is the
 * point: the 0.11.42 bypasses existed because `edit` and `bases.create` were
 * never classified as writes anywhere.
 *
 * Each write action is checked twice:
 *   - under read-only  -> must record ZERO vault writes
 *   - under permissive -> must record AT LEAST ONE write (positive control)
 *
 * The positive control is what stops a vacuous pass. Without it, an action that
 * throws on missing params would record no writes and look "correctly blocked"
 * while testing nothing at all.
 */
import { SecureObsidianAPI, VaultSecurityManager } from '../../src/security';
import { createSemanticTools, getActionsForOperation, ALL_OPERATIONS } from '../../src/tools/semantic-tools';
import { ContentBufferManager } from '../../src/utils/content-buffer';
import { App, TFile } from 'obsidian';

jest.mock('obsidian');

/**
 * Derived from ALL_OPERATIONS, not hand-listed: a hand-written list means adding
 * a whole new OPERATION silently escapes the matrix (only new *actions* on known
 * operations would be caught).
 */
const OPERATIONS: readonly string[] = ALL_OPERATIONS;

/**
 * Every action's expected effect on the vault. Adding an action to
 * getActionsForOperation() without adding it here fails the coverage test.
 *
 * 'execute' is its own kind, not a synonym for read: opening a file in the
 * Obsidian UI mutates nothing, but it maps to OperationType.EXECUTE and
 * presets.readOnly() sets execute:false, so read-only DOES block it. That is
 * over-blocking, which is the safe direction — recorded here as the actual
 * contract rather than assumed away. Note the Read-only setting description
 * enumerates only "create, update, delete, move, rename", so the copy
 * understates what the mode does.
 */
const ACTION_KIND: Record<string, 'read' | 'write' | 'execute'> = {
  // vault
  'vault.list': 'read',
  'vault.read': 'read',
  'vault.search': 'read',
  'vault.fragments': 'read',
  'vault.create': 'write',
  'vault.update': 'write',
  'vault.delete': 'write',
  'vault.move': 'write',
  'vault.rename': 'write',
  'vault.copy': 'write',
  'vault.split': 'write',
  'vault.combine': 'write',
  'vault.concatenate': 'write',
  // edit — every action mutates a note
  'edit.window': 'write',
  'edit.append': 'write',
  'edit.patch': 'write',
  'edit.at_line': 'write',
  'edit.from_buffer': 'write',
  // view
  'view.file': 'read',
  'view.window': 'read',
  'view.active': 'read',
  'view.open_in_obsidian': 'execute',
  // workflow / system
  'workflow.suggest': 'read',
  'system.info': 'read',
  'system.commands': 'read',
  'system.fetch_web': 'read',
  // graph — all analysis
  'graph.traverse': 'read',
  'graph.neighbors': 'read',
  'graph.path': 'read',
  'graph.statistics': 'read',
  'graph.backlinks': 'read',
  'graph.forwardlinks': 'read',
  'graph.search-traverse': 'read',
  'graph.advanced-traverse': 'read',
  'graph.tag-traverse': 'read',
  'graph.tag-analysis': 'read',
  'graph.shared-tags': 'read',
  // dataview — all query/inspection. dataview-tool.ts rejects format 'js', so
  // there is no execution vector here.
  'dataview.query': 'read',
  'dataview.list': 'read',
  'dataview.metadata': 'read',
  'dataview.validate': 'read',
  'dataview.status': 'read',
  // bases
  'bases.list': 'read',
  'bases.read': 'read',
  'bases.query': 'read',
  'bases.view': 'read',
  'bases.export': 'read',
  'bases.create': 'write',
};

/** Params sufficient for each write action to actually attempt a vault write. */
const WRITE_PARAMS: Record<string, Record<string, unknown>> = {
  'vault.create': { path: 'new.md', content: 'x' },
  'vault.update': { path: 'note.md', content: 'x' },
  'vault.delete': { path: 'note.md' },
  'vault.move': { path: 'note.md', destination: 'moved/note.md' },
  'vault.rename': { path: 'note.md', newName: 'renamed' },
  'vault.copy': { path: 'note.md', destination: 'copy.md' },
  'vault.split': { path: 'note.md', splitBy: 'heading', level: 1 },
  'vault.combine': { paths: ['note.md', 'other.md'], destination: 'combined.md' },
  'vault.concatenate': { path1: 'note.md', path2: 'other.md', mode: 'new', destination: 'cat.md' },
  'edit.window': { path: 'note.md', oldText: 'body', newText: 'changed' },
  'edit.append': { path: 'note.md', content: 'x' },
  'edit.patch': {
    path: 'note.md', targetType: 'heading', target: 'Heading', operation: 'append', content: 'x',
  },
  'edit.at_line': { path: 'note.md', lineNumber: 1, mode: 'replace', content: 'x' },
  'edit.from_buffer': { path: 'note.md' },
  'bases.create': { path: 'new.base', config: { views: [{ type: 'table', name: 'v' }] } },
};

/**
 * Write actions whose positive control needs state this harness doesn't build.
 * Kept deliberately tiny and loud — each entry is coverage we do NOT have.
 * Empty is the goal.
 */
const NO_POSITIVE_CONTROL: Record<string, string> = {};

/** Actions needing state set up before the call can reach a write. */
const SETUP: Record<string, () => void> = {
  // from_buffer replays whatever a prior window edit stashed, so seed the buffer.
  'edit.from_buffer': () => {
    ContentBufferManager.getInstance().store('changed', undefined, { searchText: 'body' });
  },
};

type Write = { op: string; path: string };

const PERMISSIVE = {
  pathValidation: 'strict' as const,
  permissions: {
    read: true, create: true, update: true,
    delete: true, move: true, rename: true, execute: true,
  },
  blockedPaths: [],
  logSecurityEvents: false,
};

const EXISTING = ['note.md', 'other.md'];

function mkFile(p: string): TFile {
  const f = new TFile();
  const w = f as unknown as { path: string; extension: string; name: string };
  w.path = p;
  w.extension = p.includes('.') ? p.slice(p.lastIndexOf('.') + 1) : '';
  w.name = p;
  return f;
}

function makeApp(writes: Write[]): App {
  return {
    vault: {
      adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: (p: string) => (EXISTING.includes(p) ? mkFile(p) : null),
      read: async () => '# Heading\nbody\n',
      cachedRead: async () => '# Heading\nbody\n',
      modify: async (f: TFile) => { writes.push({ op: 'modify', path: f.path }); },
      create: async (p: string) => { writes.push({ op: 'create', path: p }); return mkFile(p); },
      createFolder: async (p: string) => { writes.push({ op: 'mkdir', path: p }); },
      getFiles: () => EXISTING.map(mkFile),
      getMarkdownFiles: () => EXISTING.map(mkFile),
    },
    fileManager: {
      renameFile: async (_f: TFile, newPath: string) => { writes.push({ op: 'rename', path: newPath }); },
      trashFile: async (f: TFile) => { writes.push({ op: 'trash', path: f.path }); },
    },
    metadataCache: { getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { getActiveFile: () => mkFile('note.md'), getLeaf: () => null },
  } as unknown as App;
}

/**
 * Invoke one action through the production tool handler.
 *
 * Three modes, and the distinction matters:
 *
 *  - 'readOnly'      both gates armed — what a user actually gets
 *  - 'securityLayer' ONLY the security layer armed (plugin.settings.readOnlyMode
 *                    left false, so the tool-layer guard at semantic-tools.ts:142
 *                    never fires). Without this mode the vault.* write assertions
 *                    are satisfied by the legacy tool-layer guard and pass even on
 *                    code where the security layer is bypassed — measured: the
 *                    pre-fix tree failed only on bases.create.
 *  - 'permissive'    positive control: the call must really reach a write
 */
async function invoke(
  operation: string,
  action: string,
  params: Record<string, unknown>,
  mode: 'readOnly' | 'securityLayer' | 'permissive',
): Promise<Write[]> {
  const writes: Write[] = [];
  const app = makeApp(writes);
  const plugin = { settings: { readOnlyMode: mode === 'readOnly' } };
  const api = new SecureObsidianAPI(
    app, undefined, plugin as never,
    mode === 'permissive' ? PERMISSIVE : VaultSecurityManager.presets.readOnly(),
  );
  const tool = createSemanticTools(api)!.find(t => t.name === operation);
  if (!tool) throw new Error(`tool not found: ${operation}`);

  SETUP[`${operation}.${action}`]?.();

  try {
    await tool.handler(api, { action, ...params });
  } catch {
    // A thrown error is a legitimate outcome; the assertion is on `writes`.
  }
  return writes;
}

describe('read-only enforcement — exhaustive action matrix', () => {
  const allActions = OPERATIONS.flatMap(op =>
    getActionsForOperation(op).map(action => ({ op, action, key: `${op}.${action}` })),
  );

  /**
   * Operations whose tool exists in this environment. `dataview` is gated behind
   * the Dataview plugin being installed, so createSemanticTools omits it here and
   * its actions cannot be invoked. They are still CLASSIFIED above — the
   * fail-closed coverage check below covers the whole shipped surface — but the
   * behavioural assertions can only run against tools that exist.
   */
  const invocable = (() => {
    const probeWrites: Write[] = [];
    const probeApi = new SecureObsidianAPI(
      makeApp(probeWrites), undefined, { settings: {} } as never, PERMISSIVE,
    );
    const names = new Set((createSemanticTools(probeApi) ?? []).map(t => t.name));
    return (op: string) => names.has(op);
  })();

  it('reports which operations are not behaviourally exercised here', () => {
    const skipped = [...new Set(allActions.map(a => a.op))].filter(op => !invocable(op));
    // Not a failure — a disclosure. Silent partial coverage is what lets a gap
    // read as "covered". If this list grows, the matrix is testing less than it
    // appears to.
    expect(skipped).toEqual(['dataview']);
  });

  it('classifies every shipped action as read or write', () => {
    const unclassified = allActions.filter(a => !(a.key in ACTION_KIND)).map(a => a.key);

    expect(unclassified).toEqual([]);
    // If this fails, a new action shipped without a read/write decision. Add it
    // to ACTION_KIND (and WRITE_PARAMS if it writes) — do not delete this test.
  });

  it('has no stale entries in the classification map', () => {
    const shipped = new Set(allActions.map(a => a.key));
    const stale = Object.keys(ACTION_KIND).filter(k => !shipped.has(k));

    expect(stale).toEqual([]);
  });

  const writeActions = allActions.filter(a => ACTION_KIND[a.key] === 'write' && invocable(a.op));

  describe.each(writeActions)('$key (write)', ({ op, action, key }) => {
    const params = WRITE_PARAMS[key] ?? {};

    it('records no vault write under read-only mode', async () => {
      const writes = await invoke(op, action, params, 'readOnly');
      expect(writes).toEqual([]);
    });

    it('records no vault write with ONLY the security layer armed', async () => {
      // The assertion that actually exercises the repaired layer. With the
      // tool-layer guard disarmed, a write reaching the vault here means the
      // action bypasses SecureObsidianAPI — which is precisely how bases.create,
      // vault.move and vault.rename escaped.
      const writes = await invoke(op, action, params, 'securityLayer');
      expect(writes).toEqual([]);
    });

    if (key in NO_POSITIVE_CONTROL) {
      it.todo(`positive control missing — ${NO_POSITIVE_CONTROL[key]}`);
    } else {
      it('positive control: DOES write when permitted', async () => {
        const writes = await invoke(op, action, params, 'permissive');
        // A failure here means the read-only assertion above is vacuous: the
        // action never reached a write, so blocking it proved nothing.
        expect(writes.length).toBeGreaterThan(0);
      });
    }
  });

  const executeActions = allActions.filter(a => ACTION_KIND[a.key] === 'execute' && invocable(a.op));

  describe.each(executeActions)('$key (execute)', ({ op, action }) => {
    it('is blocked under read-only — over-blocking, documented not assumed', async () => {
      const writes: Write[] = [];
      const api = new SecureObsidianAPI(
        makeApp(writes), undefined, { settings: { readOnlyMode: true } } as never,
        VaultSecurityManager.presets.readOnly(),
      );
      const tool = createSemanticTools(api)!.find(t => t.name === op)!;

      const res = await tool.handler(api, { action, path: 'note.md' }).catch(e => ({
        content: [{ type: 'text' as const, text: String(e) }],
      }));

      // Surfaced as READ_ONLY_MODE: the security layer denies it as
      // PERMISSION_DENIED and the tool layer relabels for the caller (ADR-108).
      // Either code means the gate refused it.
      expect(JSON.stringify(res)).toMatch(/READ_ONLY_MODE|PERMISSION_DENIED/);
      expect(writes).toEqual([]);
    });
  });

  const readActions = allActions.filter(a => ACTION_KIND[a.key] === 'read' && invocable(a.op));

  describe.each(readActions)('$key (read)', ({ op, action }) => {
    it('is not denied by the permission layer under read-only', async () => {
      const writes: Write[] = [];
      const app = makeApp(writes);
      const api = new SecureObsidianAPI(
        app, undefined, { settings: { readOnlyMode: true } } as never,
        VaultSecurityManager.presets.readOnly(),
      );
      const tool = createSemanticTools(api)!.find(t => t.name === op)!;

      // Params are best-effort, so other errors are tolerated; the point is that
      // read-only must never be the reason a read fails.
      const res = await tool.handler(api, { action, path: 'note.md' }).catch(e => ({
        content: [{ type: 'text' as const, text: String(e) }],
      }));

      const text = JSON.stringify(res);
      expect(text).not.toContain('READ_ONLY_MODE');
      expect(text).not.toContain('PERMISSION_DENIED');
    });
  });
});
