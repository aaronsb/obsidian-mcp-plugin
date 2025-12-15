/**
 * System and workflow operation formatters
 */

import {
  header,
  property,
  divider,
  tip,
  summaryFooter,
  joinLines
} from './utils';

/**
 * Format system.info response
 */
export interface SystemInfoResponse {
  plugin: {
    name: string;
    version: string;
  };
  vault: {
    name: string;
    fileCount?: number;
    folderCount?: number;
  };
  server?: {
    httpEnabled: boolean;
    httpPort?: number;
  };
}

export function formatSystemInfo(response: SystemInfoResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'System Info'));
  lines.push('');

  lines.push(header(2, 'Plugin'));
  lines.push(property('Name', response.plugin.name, 0));
  lines.push(property('Version', response.plugin.version, 0));
  lines.push('');

  lines.push(header(2, 'Vault'));
  lines.push(property('Name', response.vault.name, 0));
  if (response.vault.fileCount !== undefined) {
    lines.push(property('Files', response.vault.fileCount.toString(), 0));
  }
  if (response.vault.folderCount !== undefined) {
    lines.push(property('Folders', response.vault.folderCount.toString(), 0));
  }
  lines.push('');

  if (response.server) {
    lines.push(header(2, 'Server'));
    lines.push(property('HTTP', response.server.httpEnabled ? 'Enabled' : 'Disabled', 0));
    if (response.server.httpPort) {
      lines.push(property('Port', response.server.httpPort.toString(), 0));
    }
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format system.commands response
 */
export interface CommandInfo {
  id: string;
  name: string;
}

export interface SystemCommandsResponse {
  commands: CommandInfo[];
}

export function formatSystemCommands(response: SystemCommandsResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Available Commands'));
  lines.push('');
  lines.push(`${response.commands.length} commands available`);
  lines.push('');

  // Group by prefix if possible
  const grouped = new Map<string, CommandInfo[]>();
  response.commands.forEach(cmd => {
    const prefix = cmd.id.split(':')[0] || 'other';
    const cmds = grouped.get(prefix) || [];
    cmds.push(cmd);
    grouped.set(prefix, cmds);
  });

  // Show top groups
  const sortedGroups = Array.from(grouped.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  sortedGroups.forEach(([prefix, cmds]) => {
    lines.push(header(2, `${prefix} (${cmds.length})`));
    cmds.slice(0, 5).forEach(cmd => {
      lines.push(`- ${cmd.name}`);
    });
    if (cmds.length > 5) {
      lines.push(`  ... and ${cmds.length - 5} more`);
    }
    lines.push('');
  });

  lines.push(divider());
  lines.push(tip('Commands can be executed via Obsidian\'s command palette'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format workflow.suggest response
 */
export interface WorkflowSuggestion {
  description: string;
  command: string;
  reason: string;
}

export interface WorkflowSuggestResponse {
  message: string;
  suggested_next: WorkflowSuggestion[];
}

export function formatWorkflowSuggest(response: WorkflowSuggestResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Workflow Suggestions'));
  lines.push('');
  lines.push(response.message);
  lines.push('');

  if (response.suggested_next.length === 0) {
    lines.push('No specific suggestions at this time.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  lines.push(header(2, 'Suggested Actions'));
  lines.push('');

  response.suggested_next.forEach((suggestion, i) => {
    lines.push(`${i + 1}. **${suggestion.description}**`);
    lines.push(property('Command', `\`${suggestion.command}\``, 1));
    lines.push(property('Why', suggestion.reason, 1));
    lines.push('');
  });

  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format edit operation responses
 */
export interface EditResponse {
  success: boolean;
  path: string;
  operation: 'window' | 'append' | 'patch' | 'at_line';
  linesChanged?: number;
  message?: string;
}

export function formatEditResult(response: EditResponse): string {
  const lines: string[] = [];

  const icon = response.success ? '✓' : '✗';
  const verb = response.operation === 'window' ? 'Replaced'
    : response.operation === 'append' ? 'Appended'
    : response.operation === 'patch' ? 'Patched'
    : 'Edited';

  lines.push(header(1, `${icon} ${verb}: ${response.path}`));
  lines.push('');

  if (response.success) {
    lines.push('Edit successful.');
    if (response.linesChanged !== undefined) {
      lines.push(property('Lines Changed', response.linesChanged.toString(), 0));
    }
  } else {
    lines.push(`Edit failed${response.message ? `: ${response.message}` : ''}`);
  }

  lines.push(divider());
  lines.push(tip('Use `view.file(path)` to verify the changes'));
  lines.push(summaryFooter());

  return joinLines(lines);
}
