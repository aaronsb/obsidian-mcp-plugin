/**
 * Graph operation formatters
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
 * Format graph.traverse response
 */
export interface GraphNode {
  path: string;
  title: string;
  depth: number;
  links?: string[];
  backlinks?: string[];
}

export interface GraphTraverseResponse {
  sourcePath: string;
  maxDepth: number;
  nodes: GraphNode[];
  totalNodes: number;
}

export function formatGraphTraverse(response: GraphTraverseResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Graph: ${fileName}`));
  lines.push('');
  lines.push(property('Source', response.sourcePath, 0));
  lines.push(property('Max Depth', response.maxDepth.toString(), 0));
  lines.push(property('Nodes Found', response.totalNodes.toString(), 0));
  lines.push('');

  // Group by depth
  const byDepth = new Map<number, GraphNode[]>();
  response.nodes.forEach(node => {
    const nodes = byDepth.get(node.depth) || [];
    nodes.push(node);
    byDepth.set(node.depth, nodes);
  });

  // Display hierarchy
  for (let depth = 0; depth <= response.maxDepth; depth++) {
    const nodesAtDepth = byDepth.get(depth) || [];
    if (nodesAtDepth.length === 0) continue;

    lines.push(header(2, `Depth ${depth}`));
    nodesAtDepth.slice(0, 15).forEach(node => {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}- ${node.title}`);
      if (node.links && node.links.length > 0) {
        lines.push(`${indent}  → links to: ${node.links.slice(0, 3).join(', ')}${node.links.length > 3 ? '...' : ''}`);
      }
    });
    if (nodesAtDepth.length > 15) {
      lines.push(`  ... and ${nodesAtDepth.length - 15} more at this depth`);
    }
    lines.push('');
  }

  lines.push(divider());
  lines.push(tip('Use `graph.neighbors(path)` for immediate connections only'));
  lines.push(tip('Use `graph.path(source, target)` to find routes between specific notes'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format graph.neighbors response
 * Actual response has: nodes[], edges[], message, workflow
 */
export interface GraphNeighborsNode {
  path: string;
  title: string;
  type: string;
  tags?: string[];
  links?: { forward: number; backward: number; total: number };
}

export interface GraphNeighborsEdge {
  source: string;
  target: string;
  type: string;
  count: number;
}

export interface GraphNeighborsResponse {
  sourcePath: string;
  nodes: GraphNeighborsNode[];
  edges: GraphNeighborsEdge[];
  message?: string;
}

export function formatGraphNeighbors(response: GraphNeighborsResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Neighbors: ${fileName}`));
  lines.push('');

  if (response.message) {
    lines.push(response.message);
    lines.push('');
  }

  // Source node (first node is usually the source)
  const sourceNode = response.nodes.find(n => n.path === response.sourcePath);
  const neighbors = response.nodes.filter(n => n.path !== response.sourcePath);

  if (sourceNode?.tags && sourceNode.tags.length > 0) {
    lines.push(property('Tags', sourceNode.tags.join(', '), 0));
    lines.push('');
  }

  // Connected nodes
  lines.push(header(2, `Connected Notes (${neighbors.length})`));
  if (neighbors.length === 0) {
    lines.push('No direct connections');
  } else {
    neighbors.slice(0, 20).forEach(node => {
      const linkInfo = node.links ? ` (${node.links.total} connections)` : '';
      lines.push(`- **${node.title}**${linkInfo}`);
      lines.push(`  ${node.path}`);
    });
    if (neighbors.length > 20) {
      lines.push(`... and ${neighbors.length - 20} more`);
    }
  }
  lines.push('');

  // Edge summary
  if (response.edges.length > 0) {
    const outgoing = response.edges.filter(e => e.source === response.sourcePath);
    const incoming = response.edges.filter(e => e.target === response.sourcePath);
    lines.push(property('Outgoing', outgoing.length.toString(), 0));
    lines.push(property('Incoming', incoming.length.toString(), 0));
  }

  lines.push(divider());
  lines.push(tip('Use `graph.traverse(path)` to explore deeper connections'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format graph.path response
 */
export interface GraphPathNode {
  path: string;
  title: string;
}

export interface GraphPathResponse {
  sourcePath: string;
  targetPath: string;
  found: boolean;
  paths: GraphPathNode[][];
  shortestLength?: number;
}

export function formatGraphPath(response: GraphPathResponse): string {
  const lines: string[] = [];

  const sourceFile = response.sourcePath.split('/').pop() || response.sourcePath;
  const targetFile = response.targetPath.split('/').pop() || response.targetPath;

  lines.push(header(1, `Path: ${sourceFile} → ${targetFile}`));
  lines.push('');

  if (!response.found || response.paths.length === 0) {
    lines.push('No path found between these notes.');
    lines.push('');
    lines.push(tip('These notes may not be connected through links'));
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  lines.push(property('Paths Found', response.paths.length.toString(), 0));
  if (response.shortestLength) {
    lines.push(property('Shortest', `${response.shortestLength} hops`, 0));
  }
  lines.push('');

  // Show paths
  response.paths.slice(0, 5).forEach((path, i) => {
    lines.push(header(2, `Path ${i + 1} (${path.length - 1} hops)`));
    lines.push('');

    // ASCII visualization
    path.forEach((node, j) => {
      if (j === 0) {
        lines.push(`**${node.title}**`);
      } else {
        lines.push('  ↓');
        lines.push(`${node.title}`);
      }
    });
    lines.push('');
  });

  if (response.paths.length > 5) {
    lines.push(`... and ${response.paths.length - 5} more paths`);
  }

  lines.push(divider());
  lines.push(tip('Use `vault.read(path)` to examine any node in the path'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format graph.statistics response
 * Actual response: { operation, sourcePath, statistics: {...}, message, workflow }
 */
export interface GraphStatsResponse {
  sourcePath: string;
  // Flat format (legacy)
  inDegree?: number;
  outDegree?: number;
  totalDegree?: number;
  isOrphan?: boolean;
  // Nested format (actual)
  statistics?: {
    inDegree: number;
    outDegree: number;
    totalDegree: number;
    unresolvedCount?: number;
    tagCount?: number;
  };
  message?: string;
}

export function formatGraphStats(response: GraphStatsResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Stats: ${fileName}`));
  lines.push('');

  if (response.message) {
    lines.push(response.message);
    lines.push('');
  }

  // Handle both nested and flat formats
  const stats = response.statistics || response;
  const inDegree = stats.inDegree ?? 0;
  const outDegree = stats.outDegree ?? 0;
  const totalDegree = stats.totalDegree ?? (inDegree + outDegree);

  lines.push(property('Incoming Links', inDegree.toString(), 0));
  lines.push(property('Outgoing Links', outDegree.toString(), 0));
  lines.push(property('Total Connections', totalDegree.toString(), 0));

  if (response.statistics?.unresolvedCount) {
    lines.push(property('Unresolved', response.statistics.unresolvedCount.toString(), 0));
  }
  if (response.statistics?.tagCount) {
    lines.push(property('Tags', response.statistics.tagCount.toString(), 0));
  }

  const isOrphan = response.isOrphan ?? (totalDegree === 0);
  if (isOrphan) {
    lines.push('');
    lines.push('⚠️ This note is an orphan (no incoming or outgoing links)');
  }

  lines.push(divider());
  lines.push(tip('Use `graph.neighbors(path)` to see the actual connections'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format graph.tag-analysis response
 */
export interface TagAnalysisTag {
  tag: string;
  count: number;
  files?: string[];
}

export interface TagAnalysisResponse {
  folderFilter?: string;
  totalTags: number;
  totalFiles: number;
  tags: TagAnalysisTag[];
}

export function formatTagAnalysis(response: TagAnalysisResponse): string {
  const lines: string[] = [];

  lines.push(header(1, 'Tag Analysis'));
  lines.push('');

  if (response.folderFilter) {
    lines.push(property('Folder', response.folderFilter, 0));
  }
  lines.push(property('Total Tags', response.totalTags.toString(), 0));
  lines.push(property('Total Files', response.totalFiles.toString(), 0));
  lines.push('');

  if (response.tags.length === 0) {
    lines.push('No tags found.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  lines.push(header(2, 'Tags by Frequency'));
  lines.push('');

  // Sort by count descending
  const sorted = [...response.tags].sort((a, b) => b.count - a.count);

  sorted.slice(0, 30).forEach((tag, i) => {
    lines.push(`${i + 1}. **${tag.tag}** (${tag.count} files)`);
    if (tag.files && tag.files.length > 0) {
      const preview = tag.files.slice(0, 3).map(f => f.split('/').pop()).join(', ');
      lines.push(`   ${preview}${tag.files.length > 3 ? '...' : ''}`);
    }
  });

  if (sorted.length > 30) {
    lines.push(`\n... and ${sorted.length - 30} more tags`);
  }

  lines.push('');
  lines.push(divider());
  lines.push(tip('Use `vault.search(query, tag: "#tagname")` to find files with a specific tag'));
  lines.push(summaryFooter());

  return joinLines(lines);
}

/**
 * Format graph.shared-tags response
 */
export interface SharedTagsResult {
  file1: string;
  file2: string;
  sharedTags: string[];
  similarity: number;
}

export interface SharedTagsResponse {
  sourcePath: string;
  results: SharedTagsResult[];
  totalMatches: number;
}

export function formatSharedTags(response: SharedTagsResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Shared Tags: ${fileName}`));
  lines.push('');
  lines.push(property('Source', response.sourcePath, 0));
  lines.push(property('Matches', response.totalMatches.toString(), 0));
  lines.push('');

  if (response.results.length === 0) {
    lines.push('No files share tags with this file.');
    lines.push(summaryFooter());
    return joinLines(lines);
  }

  lines.push(header(2, 'Related Files'));
  lines.push('');

  response.results.slice(0, 20).forEach((result, i) => {
    const otherFile = result.file1 === response.sourcePath ? result.file2 : result.file1;
    const otherName = otherFile.split('/').pop() || otherFile;
    const similarity = Math.round(result.similarity * 100);

    lines.push(`${i + 1}. **${otherName}** (${similarity}% similar)`);
    lines.push(`   Shared: ${result.sharedTags.slice(0, 5).join(', ')}${result.sharedTags.length > 5 ? '...' : ''}`);
  });

  if (response.results.length > 20) {
    lines.push(`\n... and ${response.results.length - 20} more matches`);
  }

  lines.push('');
  lines.push(divider());
  lines.push(tip('Use `graph.path(source, target)` to find connection paths between files'));
  lines.push(summaryFooter());

  return joinLines(lines);
}
