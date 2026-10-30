/**
 * system.execute — ADR-204's three gates and "dispatch is not completion" (#312).
 *
 * Running a command-palette command is the most dangerous thing this plugin can
 * expose, so every gate is asserted on its OUTCOME: a recorder stands in for
 * `app.commands.executeCommandById` and keeps the id of every command Obsidian
 * was asked to run. A refused call must leave it empty. A refusal message alone
 * proves nothing if the command ran anyway.
 *
 * Calls go through the MCP pool's real tools/list and tools/call handlers, the
 * path a client takes, with only the Obsidian app and its DOM faked.
 *
 * The three gates, each at its own layer:
 *   1. enumeration  toolVisibility['system.execute'] must be explicitly true
 *                   (opt-in, the inverse of ADR-101's default), re-checked at
 *                   dispatch
 *   2. permission   OperationType.EXECUTE, denied in readOnly and safeMode
 *   3. allowlist    commandExecutionAllowlist holds exact command ids, empty by
 *                   default, checked before executeCommandById
 */
import { MCPServerPool } from '../../src/utils/mcp-server-pool';
import { SecureObsidianAPI, SecurityError, VaultSecurityManager } from '../../src/security';
import type { SecuritySettings } from '../../src/security';
import { BASELINE_SECURITY_SETTINGS } from '../../src/mcp-server';
import {
  OPT_IN_ACTIONS, applyVisibilityToggle, isActionVisible, isOperationHidden, visibilityRowValue,
} from '../../src/tools/semantic-tools';
import { addableCommands, allowlistEntries, normalizeAllowlist } from '../../src/utils/obsidian-commands';
import * as obsidian from 'obsidian';
import { App } from 'obsidian';

jest.mock('obsidian');

const COMMANDS: Record<string, { id: string; name: string }> = {
  'editor:save-file': { id: 'editor:save-file', name: 'Save current file' },
  'app:delete-file': { id: 'app:delete-file', name: 'Delete current file' },
  'switcher:open': { id: 'switcher:open', name: 'Quick switcher: Open quick switcher' },
};

/** A dialog element. Records anything that would dismiss or confirm it. */
class FakeDialog {
  constructor(readonly cls: 'modal-container' | 'prompt', private readonly doc: FakeDocument) {}
  remove() { this.doc.touched.push(`remove:${this.cls}`); }
  click() { this.doc.touched.push(`click:${this.cls}`); }
  dispatchEvent() { this.doc.touched.push(`event:${this.cls}`); return true; }
}

/** Just the DOM surface dialog detection reads, plus a record of interference. */
class FakeDocument {
  dialogs: FakeDialog[] = [];
  touched: string[] = [];
  querySelectorAll(selector: string): FakeDialog[] {
    // Match on the selector the code passes, so dropping either class from it fails.
    return this.dialogs.filter(d => selector.split(',').map(s => s.trim()).includes(`.${d.cls}`));
  }
  dispatchEvent() { this.touched.push('event:document'); return true; }
}

interface Options {
  visibility?: Record<string, boolean>;
  allowlist?: string[];
  notify?: boolean;
  readOnly?: boolean;
  security?: Partial<SecuritySettings>;
  /** What the command opens when it runs. */
  opens?: 'modal-container' | 'prompt';
  /** A dialog the user already had open before the agent's call. */
  alreadyOpen?: 'modal-container' | 'prompt';
}

interface ToolsResult {
  tools: { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[];
}
interface CallResult { content: { type: string; text: string }[]; isError?: boolean }

type Handler<T> = (req: unknown, extra: unknown) => Promise<T>;

function setup(opts: Options = {}) {
  const ran: string[] = [];
  const doc = new FakeDocument();
  if (opts.alreadyOpen) doc.dialogs.push(new FakeDialog(opts.alreadyOpen, doc));
  (globalThis as { activeDocument?: unknown }).activeDocument = doc;

  const app = {
    vault: {
      configDir: '.obsidian', adapter: { basePath: '/test/vault' },
      getAbstractFileByPath: () => null,
      getFiles: () => [],
      getMarkdownFiles: () => [],
    },
    metadataCache: { getFileCache: () => null, resolvedLinks: {} },
    workspace: { getActiveFile: () => null },
    commands: {
      commands: COMMANDS,
      executeCommandById: (id: string) => {
        ran.push(id);
        if (opts.opens) doc.dialogs.push(new FakeDialog(opts.opens, doc));
        return id in COMMANDS;
      },
    },
  } as unknown as App;

  const settings: Record<string, unknown> = {
    readOnlyMode: opts.readOnly === true,
    enableWebFetch: false,
    toolVisibility: opts.visibility ?? {},
    commandExecutionAllowlist: opts.allowlist ?? [],
  };
  if (opts.notify !== undefined) settings.notifyOnCommandExecution = opts.notify;
  const plugin = { settings, manifest: { dir: '/test/vault/.obsidian/plugins/semantic-vault-mcp' } };

  const api = new SecureObsidianAPI(app, undefined, plugin, opts.security ?? BASELINE_SECURITY_SETTINGS);
  const pool = new MCPServerPool(api, 8, plugin);
  const handlers = (pool.getOrCreateServer('s').server as unknown as {
    _requestHandlers: Map<string, Handler<unknown>>;
  })._requestHandlers;

  const systemTool = async () => {
    const list = await (handlers.get('tools/list') as Handler<ToolsResult>)({ method: 'tools/list', params: {} }, {});
    return list.tools.find(t => t.name === 'system');
  };
  const call = (args: Record<string, unknown>) =>
    (handlers.get('tools/call') as Handler<CallResult>)(
      { method: 'tools/call', params: { name: 'system', arguments: args } }, {},
    );
  /** The parsed JSON of a raw call: `result` on success, `error` on refusal. */
  const callRaw = async (args: Record<string, unknown>) => {
    const res = await call({ ...args, raw: true });
    return JSON.parse(res.content[0].text) as {
      result?: { success: boolean; commandId: string; awaitingUserInteraction: boolean; warning?: string };
      error?: { code: string; message: string };
    };
  };

  return { ran, doc, settings, api, systemTool, call, callRaw };
}

const OPTED_IN = { 'system.execute': true };
const SAVE = { action: 'execute', commandId: 'editor:save-file' };

let noticeSpy: jest.SpyInstance;

beforeEach(() => {
  // Record the message only; the mock class is not constructible through a spy.
  noticeSpy = jest.spyOn(obsidian as never, 'Notice' as never).mockImplementation((() => ({})) as never);
});

afterEach(() => {
  noticeSpy.mockRestore();
  delete (globalThis as { activeDocument?: unknown }).activeDocument;
});

const noticeMessages = () => noticeSpy.mock.calls.map(args => String(args[0]));

describe('system.execute', () => {
  describe('gate 1: opt-in enumeration', () => {
    it('is the one opt-in action', () => {
      expect([...OPT_IN_ACTIONS]).toEqual(['system.execute']);
    });

    it.each([
      ['missing', {}],
      ['false', { 'system.execute': false }],
    ])('is absent from tools/list when the key is %s', async (_label, visibility) => {
      const tool = await setup({ visibility, allowlist: ['editor:save-file'] }).systemTool();
      expect(tool!.inputSchema.properties.action.enum).toEqual(['info', 'commands']);
      expect(tool!.inputSchema.properties).not.toHaveProperty('commandId');
      expect(tool!.description).not.toContain('execute');
    });

    it('is listed, with commandId and a dispatch-only description, when the key is true', async () => {
      const tool = await setup({ visibility: OPTED_IN }).systemTool();
      expect(tool!.inputSchema.properties.action.enum).toEqual(['info', 'commands', 'execute']);
      expect(tool!.inputSchema.properties).toHaveProperty('commandId');
      expect(tool!.description).toContain('success means the command was dispatched, not that it finished');
    });

    it.each([
      ['missing', {}],
      ['false', { 'system.execute': false }],
    ])('is refused at dispatch when the key is %s, even for an allowlisted id', async (_label, visibility) => {
      const { ran, callRaw } = setup({ visibility, allowlist: ['editor:save-file'] });
      const out = await callRaw(SAVE);
      expect(out.error?.code).toBe('ACTION_DISABLED');
      expect(ran).toEqual([]);
    });

    it('is refused on a live session once the key is switched off (handler re-check)', async () => {
      const { ran, settings, systemTool, callRaw } = setup({
        visibility: { 'system.execute': true }, allowlist: ['editor:save-file'],
      });
      expect((await systemTool())!.inputSchema.properties.action.enum).toContain('execute');

      applyVisibilityToggle(settings.toolVisibility as Record<string, boolean>, 'system.execute', false);

      expect((await callRaw(SAVE)).error?.code).toBe('ACTION_DISABLED');
      expect(ran).toEqual([]);
    });
  });

  describe('gate 1: the settings tree cannot opt in by accident', () => {
    it('shows the execute row off when the key is missing', () => {
      expect(visibilityRowValue({}, 'system.execute')).toBe(false);
      expect(isActionVisible({}, 'system', 'execute')).toBe(false);
    });

    it('does not opt in when the system parent is switched on', () => {
      const v = applyVisibilityToggle({}, 'system', true);
      expect(isActionVisible(v, 'system', 'execute')).toBe(false);
      expect(isActionVisible(v, 'system', 'info')).toBe(true);
    });

    it('does not restore execute when the parent goes off and back on', () => {
      const v: Record<string, boolean> = { 'system.execute': true };
      applyVisibilityToggle(v, 'system', false);
      applyVisibilityToggle(v, 'system', true);
      expect(isActionVisible(v, 'system', 'execute')).toBe(false);
      expect(isActionVisible(v, 'system', 'commands')).toBe(true);
    });

    it('leaves an existing opt-in alone when the parent is switched on', () => {
      const v = applyVisibilityToggle({ 'system.execute': true }, 'system', true);
      expect(isActionVisible(v, 'system', 'execute')).toBe(true);
    });

    it('opts in only through its own row', () => {
      const v = applyVisibilityToggle({}, 'system.execute', true);
      expect(v['system.execute']).toBe(true);
      expect(visibilityRowValue(v, 'system.execute')).toBe(true);
    });

    it('does not count the default-off execute row as hiding the system operation', () => {
      expect(isOperationHidden({}, 'system')).toBe(false);
      expect(visibilityRowValue({}, 'system')).toBe(true);
    });
  });

  describe('gate 2: permission (OperationType.EXECUTE)', () => {
    it.each([
      ['readOnly', VaultSecurityManager.presets.readOnly()],
      ['safeMode', VaultSecurityManager.presets.safeMode()],
    ])('%s preset denies with a SecurityError before anything runs', async (_label, security) => {
      const { ran, api, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'], security });

      const thrown = await api.executeCommand('editor:save-file').catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(SecurityError);
      expect((thrown as SecurityError).code).toBe('PERMISSION_DENIED');

      expect((await callRaw(SAVE)).error?.code).toBe('PERMISSION_DENIED');
      expect(ran).toEqual([]);
    });

    it('live read-only mode denies, reported as READ_ONLY_MODE', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'], readOnly: true });
      expect((await callRaw(SAVE)).error?.code).toBe('READ_ONLY_MODE');
      expect(ran).toEqual([]);
    });

    it('fullAccess permits (positive control for the two denials above)', async () => {
      const { ran, callRaw } = setup({
        visibility: OPTED_IN, allowlist: ['editor:save-file'], security: VaultSecurityManager.presets.fullAccess(),
      });
      expect((await callRaw(SAVE)).result?.success).toBe(true);
      expect(ran).toEqual(['editor:save-file']);
    });
  });

  describe('gate 3: allowlist', () => {
    it('refuses every command while the allowlist is empty, and runs nothing', async () => {
      const { ran, callRaw, call } = setup({ visibility: OPTED_IN });
      const out = await callRaw(SAVE);
      expect(out.error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(out.error?.message).toContain('editor:save-file');
      expect((await call(SAVE)).isError).toBe(true);
      expect(ran).toEqual([]);
    });

    it('refuses an id that is not on the list, even when another is', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      expect((await callRaw({ action: 'execute', commandId: 'app:delete-file' })).error?.code)
        .toBe('COMMAND_NOT_ALLOWED');
      expect(ran).toEqual([]);
    });

    it('matches exact ids only', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      expect((await callRaw({ action: 'execute', commandId: 'editor:save' })).error?.code)
        .toBe('COMMAND_NOT_ALLOWED');
      expect((await callRaw({ action: 'execute', commandId: 'EDITOR:SAVE-FILE' })).error?.code)
        .toBe('COMMAND_NOT_ALLOWED');
      expect(ran).toEqual([]);
    });

    it('fails closed on a malformed allowlist in data.json', async () => {
      const { ran, settings, callRaw } = setup({ visibility: OPTED_IN });
      settings.commandExecutionAllowlist = 'editor:save-file';
      expect((await callRaw(SAVE)).error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(ran).toEqual([]);
    });

    it('dispatches an allowlisted id and says it was dispatched', async () => {
      const { ran, callRaw, call } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });

      const out = await callRaw(SAVE);
      expect(out.error).toBeUndefined();
      expect(out.result).toEqual({
        success: true, commandId: 'editor:save-file', awaitingUserInteraction: false,
      });
      expect(ran).toEqual(['editor:save-file']);

      const text = (await call(SAVE)).content[0].text;
      expect(text).toContain('Dispatched');
      expect(text).toContain('does not confirm that it finished');
    });

    it('reads the allowlist live, so removing an id takes effect on the next call', async () => {
      const { ran, settings, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      settings.commandExecutionAllowlist = [];
      expect((await callRaw(SAVE)).error?.code).toBe('COMMAND_NOT_ALLOWED');
      expect(ran).toEqual([]);
    });

    it('reports a listed id Obsidian would not run as not dispatched', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['plugin:gone'] });
      const out = await callRaw({ action: 'execute', commandId: 'plugin:gone' });
      expect(ran).toEqual(['plugin:gone']);
      expect(out.result?.success).toBe(false);
      expect(out.result?.awaitingUserInteraction).toBe(false);
      expect(out.result?.warning).toContain('did not run');
    });
  });

  describe('dispatch is not completion', () => {
    it.each(['modal-container', 'prompt'] as const)(
      'reports awaitingUserInteraction when a .%s appears, and leaves it alone',
      async (opens) => {
        const { ran, doc, callRaw, call } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'], opens });

        const out = await callRaw(SAVE);
        expect(ran).toEqual(['editor:save-file']);
        expect(out.result?.success).toBe(true);
        expect(out.result?.awaitingUserInteraction).toBe(true);
        expect(out.result?.warning).toContain('waiting for the user');

        // Detected, never driven: the dialog is still there and nothing touched it.
        expect(doc.dialogs.map(d => d.cls)).toEqual([opens]);
        expect(doc.touched).toEqual([]);

        expect((await call(SAVE)).content[0].text).toContain('waiting for the user');
      },
    );

    it('does not blame the command for a dialog that was already open', async () => {
      const { callRaw } = setup({
        visibility: OPTED_IN, allowlist: ['editor:save-file'], alreadyOpen: 'modal-container',
      });
      const out = await callRaw(SAVE);
      expect(out.result?.awaitingUserInteraction).toBe(false);
      expect(out.result?.warning).toBeUndefined();
    });

    it('shows a Notice naming the command when notify is on', async () => {
      const { callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'], notify: true });
      await callRaw(SAVE);
      expect(noticeMessages()).toEqual(['An agent is running the command "Save current file".']);
    });

    it('shows the Notice when the setting is absent (default on)', async () => {
      const { callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      await callRaw(SAVE);
      expect(noticeMessages()).toEqual(['An agent is running the command "Save current file".']);
    });

    it('shows no Notice when notify is off', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'], notify: false });
      await callRaw(SAVE);
      expect(ran).toEqual(['editor:save-file']);
      expect(noticeMessages()).toEqual([]);
    });

    it('shows no Notice for a refused command, which did not run', async () => {
      const { callRaw } = setup({ visibility: OPTED_IN, notify: true });
      await callRaw(SAVE);
      expect(noticeMessages()).toEqual([]);
    });
  });

  describe('parameters', () => {
    it('rejects a missing commandId at dispatch, before any gate runs a command', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      const out = await callRaw({ action: 'execute' });
      expect(out.error?.message).toBe("system.execute requires 'commandId' (string, missing).");
      expect(ran).toEqual([]);
    });

    it('rejects a non-string commandId', async () => {
      const { ran, callRaw } = setup({ visibility: OPTED_IN, allowlist: ['editor:save-file'] });
      const out = await callRaw({ action: 'execute', commandId: 7 });
      expect(out.error?.message).toBe("system.execute requires 'commandId' (string, got number).");
      expect(ran).toEqual([]);
    });
  });
});

describe('command allowlist helpers (settings UI)', () => {
  const commands = Object.values(COMMANDS);

  it('normalizes data.json to unique strings and fails closed on anything else', () => {
    expect(normalizeAllowlist(['a:b', 'a:b', 7, null, 'c:d'])).toEqual(['a:b', 'c:d']);
    expect(normalizeAllowlist('a:b')).toEqual([]);
    expect(normalizeAllowlist(undefined)).toEqual([]);
  });

  it('marks an entry whose command is no longer registered', () => {
    expect(allowlistEntries(['editor:save-file', 'plugin:gone'], commands)).toEqual([
      { id: 'editor:save-file', name: 'Save current file', registered: true },
      { id: 'plugin:gone', name: 'plugin:gone', registered: false },
    ]);
  });

  it('offers only registered commands that are not already listed, by name', () => {
    expect(addableCommands(['editor:save-file'], commands).map(c => c.id))
      .toEqual(['app:delete-file', 'switcher:open']);
  });
});
