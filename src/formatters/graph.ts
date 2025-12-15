/**
 * Graph operation formatters
 */

import {
  header,
  property,
  divider,
  tip,
  summaryFooter,
  joinLines,
  formatPath
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
 */
export interface GraphNeighborsResponse {
  sourcePath: string;
  forwardLinks: string[];
  backLinks: string[];
}

export function formatGraphNeighbors(response: GraphNeighborsResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Neighbors: ${fileName}`));
  lines.push('');

  // Outgoing links
  lines.push(header(2, `Outgoing Links (${response.forwardLinks.length})`));
  if (response.forwardLinks.length === 0) {
    lines.push('None');
  } else {
    response.forwardLinks.slice(0, 20).forEach(link => {
      lines.push(`- ${link}`);
    });
    if (response.forwardLinks.length > 20) {
      lines.push(`... and ${response.forwardLinks.length - 20} more`);
    }
  }
  lines.push('');

  // Incoming links
  lines.push(header(2, `Incoming Links (${response.backLinks.length})`));
  if (response.backLinks.length === 0) {
    lines.push('None');
  } else {
    response.backLinks.slice(0, 20).forEach(link => {
      lines.push(`- ${link}`);
    });
    if (response.backLinks.length > 20) {
      lines.push(`... and ${response.backLinks.length - 20} more`);
    }
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
 */
export interface GraphStatsResponse {
  sourcePath: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
  isOrphan?: boolean;
}

export function formatGraphStats(response: GraphStatsResponse): string {
  const lines: string[] = [];

  const fileName = response.sourcePath.split('/').pop() || response.sourcePath;
  lines.push(header(1, `Stats: ${fileName}`));
  lines.push('');

  lines.push(property('Incoming Links', response.inDegree.toString(), 0));
  lines.push(property('Outgoing Links', response.outDegree.toString(), 0));
  lines.push(property('Total Connections', response.totalDegree.toString(), 0));

  if (response.isOrphan) {
    lines.push('');
    lines.push('⚠️ This note is an orphan (no incoming or outgoing links)');
  }

  lines.push(divider());
  lines.push(tip('Use `graph.neighbors(path)` to see the actual connections'));
  lines.push(summaryFooter());

  return joinLines(lines);
}
