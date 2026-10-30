/**
 * Obsidian's command registry, and the allowlist that gates running commands
 * from an agent (ADR-204).
 *
 * `app.commands` is not in Obsidian's public typings, so the one cast lives
 * here. Both the MCP surface (ObsidianAPI) and the settings UI read commands
 * through this module, so they see the same list.
 */
import { App, Command } from 'obsidian';

/** The internal command registry on `app.commands`. */
export interface CommandRegistry {
  commands?: Record<string, { id: string; name: string; icon?: string }>;
  executeCommandById?(id: string): boolean;
}

export function commandRegistry(app: App): CommandRegistry | undefined {
  return (app as unknown as { commands?: CommandRegistry }).commands;
}

/** Every registered command, live. */
export function listCommands(app: App): Command[] {
  const commands = commandRegistry(app)?.commands;
  if (!commands) return [];
  return Object.values(commands).map(cmd => ({ id: cmd.id, name: cmd.name, icon: cmd.icon }));
}

/**
 * The allowlist as stored, reduced to unique strings. data.json is
 * hand-editable, so anything that is not an array of strings counts as empty:
 * a malformed allowlist allows nothing.
 */
export function normalizeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string'))];
}

export interface AllowlistEntry {
  id: string;
  /** The command's name, or its id when no registered command has that id. */
  name: string;
  /** False when the id matches no registered command, so it allows nothing right now. */
  registered: boolean;
}

/** The allowlist as the settings UI shows it, with dead entries marked. */
export function allowlistEntries(allowlist: readonly string[], commands: readonly Command[]): AllowlistEntry[] {
  const byId = new Map(commands.map(c => [c.id, c.name]));
  return allowlist.map(id => {
    const name = byId.get(id);
    return { id, name: name ?? id, registered: name !== undefined };
  });
}

/**
 * The commands the settings UI offers to add: registered and not yet listed,
 * sorted by name. The UI adds only from this list and never takes typed ids,
 * so a mistyped id cannot become an entry that silently never matches.
 */
export function addableCommands(allowlist: readonly string[], commands: readonly Command[]): Command[] {
  const listed = new Set(allowlist);
  return commands.filter(c => !listed.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
}
