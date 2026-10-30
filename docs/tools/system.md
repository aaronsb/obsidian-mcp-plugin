# System Tool Documentation

The `system` tool reports on the server and Obsidian, fetches web pages, and runs Obsidian commands. Two of its actions are off by default: `fetch_web` (ADR-109) and `execute` (ADR-204).

## Actions

#### `info`
Server, vault and Obsidian version details.
```json
{ "action": "info" }
```

#### `commands`
Every registered Obsidian command, with its id and name. Use `raw: true` to get the ids, which `execute` takes.
```json
{ "action": "commands", "raw": true }
```

#### `fetch_web`
Fetch a web page and convert it to markdown. Listed only when **Settings → Security → Allow outbound web fetch** is on. Internal addresses are always blocked.
```json
{ "action": "fetch_web", "url": "https://example.com/" }
```

#### `execute`
Run an Obsidian command by its exact id.
```json
{ "action": "execute", "commandId": "editor:save-file" }
```

`success: true` means Obsidian dispatched the command. It does not mean the command finished: Obsidian reports a command as run when its callback is invoked.

```json
{
  "success": true,
  "commandId": "editor:save-file",
  "awaitingUserInteraction": false
}
```

When the command opens a dialog (a modal or a suggester), the result has `awaitingUserInteraction: true` and a `warning`. The dialog is waiting for the person at the keyboard. The plugin never confirms or dismisses it, because an agent answering a dialog it cannot read could confirm a destructive action. When `success` is `false`, Obsidian did not run the command: it is not registered, or not available right now (for example, an editor command with no note open).

## Command execution gates

`execute` runs a command only when all three gates pass. Each is off by default, so an upgraded install gains no new capability.

| Gate | Where the user sets it | Refusal |
|---|---|---|
| Enumeration | **Tool visibility → system → system.execute**. Off unless that row is turned on; turning on **All system actions** does not turn it on. | Not listed in `tools/list`; a direct call returns `ACTION_DISABLED` |
| Permission | Read-only mode denies it. So do the `readOnly` and `safeMode` security presets. | `READ_ONLY_MODE` or `PERMISSION_DENIED` |
| Allowlist | **Security → Allowed commands**. Commands are picked from the registered list, never typed. Empty allows nothing. | `COMMAND_NOT_ALLOWED` |

The gates are checked in that order. A refused call runs nothing. The allowlist is read on every call, so removing a command takes effect on the next call.

Each command an agent runs shows an Obsidian notice naming it. **Security → Notify when an agent runs a command** turns the notice off; it is on by default.

An allowlisted command whose plugin is later disabled stays on the list, marked as not registered, and allows nothing until the command is registered again.
