/**
 * Vault operation formatters (list, read, create, update, delete, etc.)
 */

import {
  header,
  property,
  truncate,
  formatFileSize,
  formatDate,
  divider,
  tip,
  summaryFooter,
  joinLines,
  formatPath,
  formatTree
} from './utils';

/**
 * Format file list results
 */
export interface FileListItem {
  path: string;
  name: string;
  isFolder?: boolean;
  size?: number;
  modified?: number;
}

export interface FileListResponse {
  directory: string;
  files: FileListItem[];
  totalFiles?: number;
  totalFolders?: number;
}

export function formatFileList(response: FileListResponse | string[]): string {
  const lines: string[] = [];

  // Handle simple string array response
  if (Array.isArray(response)) {
    const paths = response as string[];
    lines.push(header(1, 'Files'));
    lines.push('');
    lines.push(`Found ${paths.length} item${paths.length !== 1 ? 's' : ''}`);
    lines.push('');

    paths.slice(0, 50).forEach(path => {
      const name = path.split('/').pop() || path;
      const isFolder = !path.includes('.');
      lines.push(`- ${isFolder ? name + '/' : name}`);
    });

    if (paths.length > 50) {
      lines.push(`- ... and ${paths.length - 50} more`);
    }

    lines.push('');
    lines.push(divider());
    lines.push(tip('Use `vault.read(path)` to read file contents'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  // Handle structured response
  const { directory, files, totalFiles, totalFolders } = response;

  lines.push(header(1, `Directory: ${directory || '/'}`));
  lines.push('');

  const folders = files.filter(f => f.isFolder);
  const regularFiles = files.filter(f => !f.isFolder);

  // Summary
  const summaryParts: string[] = [];
  if (totalFolders !== undefined || folders.length > 0) {
    summaryParts.push(`${totalFolders ?? folders.length} folders`);
  }
  if (totalFiles !== undefined || regularFiles.length > 0) {
    summaryParts.push(`${totalFiles ?? regularFiles.length} files`);
  }
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(', '));
    lines.push('');
  }

  // Folders first
  if (folders.length > 0) {
    lines.push(header(2, 'Folders'));
    folders.slice(0, 20).forEach(f => {
      lines.push(`- ${f.name}/`);
    });
    if (folders.length > 20) {
      lines.push(`- ... and ${folders.length - 20} more folders`);
    }
    lines.push('');
  }

  // Files
  if (regularFiles.length > 0) {
    lines.push(header(2, 'Files'));
    regularFiles.slice(0, 30).forEach(f => {
      const sizeText = f.size !== undefined ? ` (${formatFileSize(f.size)})` : '';
      lines.push(`- ${f.name}${sizeText}`);
    });
    if (regularFiles.length > 30) {
      lines.push(`- ... and ${regularFiles.length - 30} more files`);
    }
    lines.push('');
  }

  lines.push(divider());
  lines.push(tip('Use `vault.read(path)` to read a file, or `vault.list(directory)` to explore a folder'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format file read response
 */
export interface FileReadResponse {
  path: string;
  content: string;
  metadata?: {
    size: number;
    modified: number;
    created?: number;
    extension: string;
  };
  frontmatter?: Record<string, any>;
  tags?: string[];
}

export function formatFileRead(response: FileReadResponse): string {
  const { path, content, metadata, frontmatter, tags } = response;
  const lines: string[] = [];

  const fileName = path.split('/').pop() || path;
  lines.push(header(1, `File: ${fileName}`));
  lines.push('');

  // Metadata summary
  lines.push(property('Path', path, 0));
  if (metadata) {
    lines.push(property('Size', formatFileSize(metadata.size), 0));
    lines.push(property('Modified', formatDate(metadata.modified), 0));
  }

  // Tags
  if (tags && tags.length > 0) {
    lines.push(property('Tags', tags.slice(0, 10).join(', '), 0));
    if (tags.length > 10) {
      lines.push(`   ... and ${tags.length - 10} more tags`);
    }
  }

  // Frontmatter summary
  if (frontmatter && Object.keys(frontmatter).length > 0) {
    lines.push('');
    lines.push(header(2, 'Frontmatter'));
    const keys = Object.keys(frontmatter).slice(0, 10);
    keys.forEach(key => {
      const value = frontmatter[key];
      const displayValue = typeof value === 'object'
        ? JSON.stringify(value).substring(0, 50)
        : String(value).substring(0, 50);
      lines.push(property(key, displayValue, 0));
    });
    if (Object.keys(frontmatter).length > 10) {
      lines.push(`... and ${Object.keys(frontmatter).length - 10} more fields`);
    }
  }

  // Content preview
  lines.push('');
  lines.push(header(2, 'Content'));
  lines.push('');

  const contentLines = content.split('\n');
  const previewLines = contentLines.slice(0, 50);
  lines.push('```markdown');
  lines.push(previewLines.join('\n'));
  if (contentLines.length > 50) {
    lines.push(`\n... (${contentLines.length - 50} more lines)`);
  }
  lines.push('```');

  lines.push(divider());
  lines.push(tip('Use `view.window(path, lineNumber)` to see a specific section'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format file write/create response
 */
export interface FileWriteResponse {
  path: string;
  success: boolean;
  created?: boolean;
  size?: number;
}

export function formatFileWrite(response: FileWriteResponse, action: 'create' | 'update'): string {
  const lines: string[] = [];

  const verb = action === 'create' ? 'Created' : 'Updated';
  const icon = response.success ? '✓' : '✗';

  lines.push(header(1, `${icon} ${verb}: ${response.path}`));
  lines.push('');

  if (response.success) {
    lines.push(`Successfully ${verb.toLowerCase()} file.`);
    if (response.size !== undefined) {
      lines.push(property('Size', formatFileSize(response.size), 0));
    }
  } else {
    lines.push(`Failed to ${action} file.`);
  }

  lines.push(divider());
  lines.push(tip('Use `vault.read(path)` to verify the content'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format file delete response
 */
export interface FileDeleteResponse {
  path: string;
  success: boolean;
}

export function formatFileDelete(response: FileDeleteResponse): string {
  const lines: string[] = [];

  const icon = response.success ? '✓' : '✗';
  lines.push(header(1, `${icon} Deleted: ${response.path}`));
  lines.push('');

  if (response.success) {
    lines.push('File successfully deleted.');
  } else {
    lines.push('Failed to delete file.');
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format file move/rename/copy response
 */
export interface FileMoveResponse {
  source: string;
  destination: string;
  success: boolean;
  operation: 'move' | 'rename' | 'copy';
}

export function formatFileMove(response: FileMoveResponse): string {
  const lines: string[] = [];

  const icon = response.success ? '✓' : '✗';
  const verb = response.operation.charAt(0).toUpperCase() + response.operation.slice(1);

  lines.push(header(1, `${icon} ${verb}: ${response.source}`));
  lines.push('');

  if (response.success) {
    lines.push(property('From', response.source, 0));
    lines.push(property('To', response.destination, 0));
    lines.push('');
    lines.push(`Successfully ${response.operation}d.`);
  } else {
    lines.push(`Failed to ${response.operation} file.`);
  }

  lines.push(summaryFooter());

  return joinLines(lines);
}
