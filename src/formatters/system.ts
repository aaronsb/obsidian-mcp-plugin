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
 * Actual response: { authenticated, cors, ok, service, versions: {obsidian, self}, mcp: {running, port, connections, vault} }
 */
export interface SystemInfoResponse {
  authenticated?: boolean;
  ok?: boolean;
  service?: string;
  versions?: {
    obsidian?: string;
    self?: string;
  };
  mcp?: {
    running?: boolean;
    port?: number;
    connections?: number;
    vault?: string;
  };
  // Legacy format support
  plugin?: {
    name: string;
    version: string;
  };
  vault?: {
    name: string;
    fileCount?: number;
    folderCount?: number;
  };
}

export function formatSystemInfo(response: SystemInfoResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'System Info'));
  lines.push('');

  // Handle actual API response format
  if (response.service || response.versions) {
    if (response.service) {
      lines.push(property('Service', response.service, 0));
    }
    if (response.versions?.self) {
      lines.push(property('Version', response.versions.self, 0));
    }
    if (response.versions?.obsidian) {
      lines.push(property('Obsidian', response.versions.obsidian, 0));
    }
    lines.push(property('Status', response.ok ? '✓ OK' : '✗ Error', 0));
    lines.push('');

    if (response.mcp) {
      lines.push(header(2, 'MCP Server'));
      lines.push(property('Running', response.mcp.running ? 'Yes' : 'No', 0));
      if (response.mcp.port) {
        lines.push(property('Port', response.mcp.port.toString(), 0));
      }
      if (response.mcp.connections !== undefined) {
        lines.push(property('Connections', response.mcp.connections.toString(), 0));
      }
      if (response.mcp.vault) {
        lines.push(property('Vault', response.mcp.vault, 0));
      }
    }
  } else if (response.plugin) {
    // Legacy format
    lines.push(header(2, 'Plugin'));
    lines.push(property('Name', response.plugin.name, 0));
    lines.push(property('Version', response.plugin.version, 0));
    lines.push('');

    if (response.vault) {
      lines.push(header(2, 'Vault'));
      lines.push(property('Name', response.vault.name, 0));
      if (response.vault.fileCount !== undefined) {
        lines.push(property('Files', response.vault.fileCount.toString(), 0));
      }
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
 * Actual response: { current_context: {...}, suggestions: [...] }
 */
export interface WorkflowSuggestion {
  description: string;
  command: string;
  reason: string;
}

export interface WorkflowSuggestResponse {
  // Legacy format
  message?: string;
  suggested_next?: WorkflowSuggestion[];
  // Actual format
  current_context?: {
    buffer_available?: boolean;
    has_links?: boolean;
    has_tags?: boolean;
  };
  suggestions?: WorkflowSuggestion[];
}

export function formatWorkflowSuggest(response: WorkflowSuggestResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Workflow Suggestions'));
  lines.push('');

  // Show context if available
  if (response.current_context) {
    const ctx = response.current_context;
    const contextItems: string[] = [];
    if (ctx.buffer_available) contextItems.push('buffer available');
    if (ctx.has_links) contextItems.push('has links');
    if (ctx.has_tags) contextItems.push('has tags');

    if (contextItems.length > 0) {
      lines.push(property('Context', contextItems.join(', '), 0));
      lines.push('');
    }
  }

  if (response.message) {
    lines.push(response.message);
    lines.push('');
  }

  // Handle both formats
  const suggestions = response.suggestions || response.suggested_next || [];

  if (suggestions.length === 0) {
    lines.push('No specific suggestions at this time.');
    lines.push('');
    lines.push(tip('Try performing an operation first to get contextual suggestions'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  lines.push(header(2, 'Suggested Actions'));
  lines.push('');

  suggestions.forEach((suggestion, i) => {
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
