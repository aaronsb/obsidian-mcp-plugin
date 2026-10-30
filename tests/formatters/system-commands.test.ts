/**
 * system.commands lists ids, because system.execute takes ids.
 *
 * The plain-text view showed names only, so an agent had to ask for `raw: true`
 * to find the one thing it could act on. Its tip also said commands are
 * "executed via Obsidian's command palette", which reads as an instruction to
 * the agent and says nothing about system.execute, which is off by default.
 */
import { formatSystemCommands } from '../../src/formatters/system';

const response = {
  commands: [
    { id: 'editor:save-file', name: 'Save current file' },
    { id: 'editor:toggle-bold', name: 'Toggle bold' },
    { id: 'switcher:open', name: 'Quick switcher: Open quick switcher' },
  ],
};

describe('formatSystemCommands', () => {
  it('shows each command id next to its name', () => {
    const text = formatSystemCommands(response);
    expect(text).toContain('`editor:save-file` Save current file');
    expect(text).toContain('`switcher:open` Quick switcher: Open quick switcher');
  });

  it('says system.execute takes the id and only when the user allows it', () => {
    const text = formatSystemCommands(response);
    expect(text).not.toContain("command palette");
    expect(text).toContain('system.execute takes the id');
    expect(text).toContain('allowlist');
  });
});
