import { App, TFile, CachedMetadata } from 'obsidian';

/**
 * Represents a node in the Obsidian vault graph
 */
export interface GraphNode {
  file: TFile | null;
  path: string;
  title: string;
  metadata?: CachedMetadata;
}

/**
 * Represents an edge between two nodes
 */
export interface GraphEdge {
  source: string; // source file path
  target: string; // target file path
  type: 'link' | 'embed' | 'tag';
  count: number; // number of links/references
}

/**
 * Options for graph traversal
 */
export interface GraphTraversalOptions {
  maxDepth?: number;
  maxNodes?: number;
  includeUnresolved?: boolean;
  followBacklinks?: boolean;
  followForwardLinks?: boolean;
  followTags?: boolean;
  nodeFilter?: (node: GraphNode) => boolean;
  edgeFilter?: (edge: GraphEdge) => boolean;
}

/**
 * Result of a graph traversal operation
 */
export interface GraphTraversalResult {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  paths?: string[][];
  stats: {
    totalNodes: number;
    totalEdges: number;
    maxDepthReached: number;
    traversalTime: number;
  };
}

/**
 * Utility class for traversing the Obsidian vault graph
 */
export class GraphTraversal {
  constructor(private app: App) {}

  /**
   * Get all nodes (files) in the vault
   */
  getAllNodes(): GraphNode[] {
    const files = this.app.vault.getFiles();
    return files.map(file => ({
      file,
      path: file.path,
      title: file.basename,
      metadata: this.app.metadataCache.getFileCache(file) || undefined
    }));
  }

  /**
   * Get backlinks (incoming links) for a file
   */
  getBacklinks(filePath: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    // Search through all files for links to this file
    for (const sourcePath in resolvedLinks) {
      const links = resolvedLinks[sourcePath];
      if (links[filePath]) {
        edges.push({
          source: sourcePath,
          target: filePath,
          type: 'link',
          count: links[filePath]
        });
      }
    }

    return edges;
  }

  /**
   * Get forward links (outgoing links) from a file
   */
  getForwardLinks(filePath: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const links = this.app.metadataCache.resolvedLinks[filePath];

    if (links) {
      for (const targetPath in links) {
        edges.push({
          source: filePath,
          target: targetPath,
          type: 'link',
          count: links[targetPath]
        });
      }
    }

    return edges;
  }

  /**
   * Get unresolved links from a file
   */
  getUnresolvedLinks(filePath: string): string[] {
    const unresolvedLinks = this.app.metadataCache.unresolvedLinks[filePath];
    return unresolvedLinks ? Object.keys(unresolvedLinks) : [];
  }

  /**
   * Get all files that share tags with the given file
   */
  getTagConnections(filePath: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const file = this.app.vault.getAbstractFileByPath(filePath);
    
    if (!(file instanceof TFile)) return edges;

    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.tags) return edges;

    const fileTags = new Set(cache.tags.map(t => t.tag));
    
    // Find other files with matching tags
    const files = this.app.vault.getFiles();
    for (const otherFile of files) {
      if (otherFile.path === filePath) continue;
      
      const otherCache = this.app.metadataCache.getFileCache(otherFile);
      if (!otherCache?.tags) continue;

      const sharedTags = otherCache.tags.filter(t => fileTags.has(t.tag));
      if (sharedTags.length > 0) {
        edges.push({
          source: filePath,
          target: otherFile.path,
          type: 'tag',
          count: sharedTags.length
        });
      }
    }

    return edges;
  }

  /**
   * Perform breadth-first traversal from a starting node
   */
  breadthFirstTraversal(
    startPath: string,
    options: GraphTraversalOptions = {}
  ): GraphTraversalResult {
    const startTime = Date.now();
    const {
      maxDepth = 3,
      maxNodes = 100,
      followBacklinks = true,
      followForwardLinks = true,
      followTags = false,
      nodeFilter,
      edgeFilter
    } = options;

    const visited = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    // Handle root path "/" by starting from all root-level files
    let initialPaths: Array<{ path: string; depth: number }> = [];

    if (startPath === '/' || startPath === '') {
      // Get all files in the vault and start with a subset
      const allFiles = this.app.vault.getFiles();

      // Sort by modification time to get most relevant files first
      const sortedFiles = allFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

      // Take up to 10 most recently modified files as starting points
      const startingFiles = sortedFiles.slice(0, Math.min(10, sortedFiles.length));

      initialPaths = startingFiles.map(file => ({ path: file.path, depth: 0 }));

      if (initialPaths.length === 0) {
        // No files in vault
        return {
          nodes: visited,
          edges,
          stats: {
            totalNodes: 0,
            totalEdges: 0,
            maxDepthReached: 0,
            traversalTime: Date.now() - startTime
          }
        };
      }
    } else {
      // Normal single file starting point
      initialPaths = [{ path: startPath, depth: 0 }];
    }

    const queue: Array<{ path: string; depth: number }> = [...initialPaths];
    let maxDepthReached = 0;

    while (queue.length > 0 && visited.size < maxNodes) {
      const { path, depth } = queue.shift()!;
      
      if (visited.has(path) || depth > maxDepth) continue;
      
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const node: GraphNode = {
        file,
        path: file.path,
        title: file.basename,
        metadata: this.app.metadataCache.getFileCache(file) || undefined
      };

      if (nodeFilter && !nodeFilter(node)) continue;

      visited.set(path, node);
      maxDepthReached = Math.max(maxDepthReached, depth);

      // Get connected nodes
      if (followForwardLinks) {
        const forwardLinks = this.getForwardLinks(path);
        for (const edge of forwardLinks) {
          if (!edgeFilter || edgeFilter(edge)) {
            edges.push(edge);
            if (!visited.has(edge.target) && depth < maxDepth) {
              queue.push({ path: edge.target, depth: depth + 1 });
            }
          }
        }
      }

      if (followBacklinks) {
        const backlinks = this.getBacklinks(path);
        for (const edge of backlinks) {
          if (!edgeFilter || edgeFilter(edge)) {
            edges.push(edge);
            if (!visited.has(edge.source) && depth < maxDepth) {
              queue.push({ path: edge.source, depth: depth + 1 });
            }
          }
        }
      }

      if (followTags) {
        const tagConnections = this.getTagConnections(path);
        for (const edge of tagConnections) {
          if (!edgeFilter || edgeFilter(edge)) {
            edges.push(edge);
            if (!visited.has(edge.target) && depth < maxDepth) {
              queue.push({ path: edge.target, depth: depth + 1 });
            }
          }
        }
      }
    }

    return {
      nodes: visited,
      edges,
      stats: {
        totalNodes: visited.size,
        totalEdges: edges.length,
        maxDepthReached,
        traversalTime: Date.now() - startTime
      }
    };
  }

  /**
   * Find shortest path between two nodes using BFS
   */
  findShortestPath(
    sourcePath: string,
    targetPath: string,
    options: Omit<GraphTraversalOptions, 'maxNodes'> = {}
  ): string[] | null {
    const queue: Array<{ path: string; pathSoFar: string[] }> = [
      { path: sourcePath, pathSoFar: [sourcePath] }
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { path, pathSoFar } = queue.shift()!;
      
      if (path === targetPath) {
        return pathSoFar;
      }

      if (visited.has(path)) continue;
      visited.add(path);

      // Get neighbors
      const forwardLinks = this.getForwardLinks(path);
      const backlinks = options.followBacklinks !== false ? this.getBacklinks(path) : [];
      
      const neighbors = new Set<string>();
      forwardLinks.forEach(edge => neighbors.add(edge.target));
      backlinks.forEach(edge => neighbors.add(edge.source));

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push({
            path: neighbor,
            pathSoFar: [...pathSoFar, neighbor]
          });
        }
      }
    }

    return null; // No path found
  }

  /**
   * Find all paths between two nodes up to a certain depth
   */
  findAllPaths(
    sourcePath: string,
    targetPath: string,
    maxDepth: number = 5
  ): string[][] {
    const paths: string[][] = [];
    const visited = new Set<string>();

    const dfs = (currentPath: string[], currentNode: string, depth: number) => {
      if (depth > maxDepth) return;
      if (currentNode === targetPath) {
        paths.push([...currentPath]);
        return;
      }

      visited.add(currentNode);

      const forwardLinks = this.getForwardLinks(currentNode);
      for (const edge of forwardLinks) {
        if (!visited.has(edge.target)) {
          dfs([...currentPath, edge.target], edge.target, depth + 1);
        }
      }

      visited.delete(currentNode);
    };

    dfs([sourcePath], sourcePath, 0);
    return paths;
  }

  /**
   * Get the local neighborhood of a node (all directly connected nodes)
   */
  getLocalNeighborhood(filePath: string): {
    node: GraphNode;
    neighbors: GraphNode[];
    edges: GraphEdge[];
  } {
    // Handle root path "/" specially
    if (filePath === '/' || filePath === '') {
      // For root, return a virtual node representing the vault with recent files as neighbors
      const allFiles = this.app.vault.getFiles();
      const sortedFiles = allFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
      const recentFiles = sortedFiles.slice(0, Math.min(20, sortedFiles.length));

      const neighbors: GraphNode[] = recentFiles.map(file => ({
        file,
        path: file.path,
        title: file.basename,
        metadata: this.app.metadataCache.getFileCache(file) || undefined
      }));

      // Create a virtual root node
      const rootNode: GraphNode = {
        file: null, // Virtual node, no actual file
        path: '/',
        title: 'Vault Root',
        metadata: undefined
      };

      // Create edges from root to recent files
      const edges: GraphEdge[] = neighbors.map(n => ({
        source: '/',
        target: n.path,
        type: 'link' as const,
        count: 1
      }));

      return {
        node: rootNode,
        neighbors,
        edges
      };
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const node: GraphNode = {
      file,
      path: file.path,
      title: file.basename,
      metadata: this.app.metadataCache.getFileCache(file) || undefined
    };

    const forwardLinks = this.getForwardLinks(filePath);
    const backlinks = this.getBacklinks(filePath);
    const allEdges = [...forwardLinks, ...backlinks];

    const neighborPaths = new Set<string>();
    forwardLinks.forEach(edge => neighborPaths.add(edge.target));
    backlinks.forEach(edge => neighborPaths.add(edge.source));

    const neighbors: GraphNode[] = [];
    for (const path of neighborPaths) {
      const neighborFile = this.app.vault.getAbstractFileByPath(path);
      if (neighborFile instanceof TFile) {
        neighbors.push({
          file: neighborFile,
          path: neighborFile.path,
          title: neighborFile.basename,
          metadata: this.app.metadataCache.getFileCache(neighborFile) || undefined
        });
      }
    }

    return { node, neighbors, edges: allEdges };
  }

  /**
   * Calculate graph statistics for a file
   */
  getNodeStatistics(filePath: string): {
    inDegree: number;
    outDegree: number;
    totalDegree: number;
    unresolvedCount: number;
    tagCount: number;
  } {
    const backlinks = this.getBacklinks(filePath);
    const forwardLinks = this.getForwardLinks(filePath);
    const unresolvedLinks = this.getUnresolvedLinks(filePath);
    
    const file = this.app.vault.getAbstractFileByPath(filePath);
    let tagCount = 0;
    if (file instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(file);
      tagCount = cache?.tags?.length || 0;
    }

    return {
      inDegree: backlinks.length,
      outDegree: forwardLinks.length,
      totalDegree: backlinks.length + forwardLinks.length,
      unresolvedCount: unresolvedLinks.length,
      tagCount
    };
  }
}