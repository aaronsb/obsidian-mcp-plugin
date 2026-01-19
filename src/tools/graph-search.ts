import { ObsidianAPI } from '../utils/obsidian-api';
import { GraphTraversal, GraphTraversalOptions, GraphNode } from '../utils/graph-traversal';
import { App, TFile } from 'obsidian';

/**
 * Graph search parameters
 */
export interface GraphSearchParams {
  // Starting point for the search
  sourcePath?: string;
  
  // Target path for pathfinding operations
  targetPath?: string;
  
  // Type of graph operation
  operation: 'traverse' | 'neighbors' | 'path' | 'statistics' | 'backlinks' | 'forwardlinks';
  
  // Options for traversal
  maxDepth?: number;
  maxNodes?: number;
  includeUnresolved?: boolean;
  followBacklinks?: boolean;
  followForwardLinks?: boolean;
  followTags?: boolean;
  
  // Filters
  fileFilter?: string; // regex pattern for file names
  tagFilter?: string[]; // only include files with these tags
  folderFilter?: string; // only include files in this folder
}

/**
 * Graph search result
 */
export interface GraphSearchResult {
  operation: string;
  sourcePath?: string;
  targetPath?: string;
  nodes?: Array<{
    path: string;
    title: string;
    type: 'file';
    tags?: string[];
    links?: {
      forward: number;
      backward: number;
      total: number;
    };
  }>;
  edges?: Array<{
    source: string;
    target: string;
    type: 'link' | 'embed' | 'tag';
    count: number;
  }>;
  paths?: string[][];
  statistics?: {
    inDegree: number;
    outDegree: number;
    totalDegree: number;
    unresolvedCount: number;
    tagCount: number;
  };
  graphStats?: {
    totalNodes: number;
    totalEdges: number;
    maxDepthReached?: number;
    traversalTime?: number;
  };
  message?: string;
  workflow?: {
    message: string;
    suggested_next: Array<{
      description: string;
      command: string;
      reason: string;
    }>;
  };
}

/**
 * Tool for searching and traversing the Obsidian vault graph
 */
export class GraphSearchTool {
  private graphTraversal: GraphTraversal;
  
  constructor(private api: ObsidianAPI, private app: App) {
    this.graphTraversal = new GraphTraversal(app);
  }

  /**
   * Execute a graph search operation
   */
  async search(params: GraphSearchParams): Promise<GraphSearchResult> {
    const { operation } = params;
    
    switch (operation) {
      case 'traverse':
        return this.performTraversal(params);
      case 'neighbors':
        return this.getNeighbors(params);
      case 'path':
        return this.findPath(params);
      case 'statistics':
        return this.getStatistics(params);
      case 'backlinks':
        return this.getBacklinks(params);
      case 'forwardlinks':
        return this.getForwardLinks(params);
      default: {
        const exhaustiveCheck: never = operation;
        throw new Error(`Unknown graph operation: ${String(exhaustiveCheck)}`);
      }
    }
  }

  /**
   * Perform graph traversal from a starting point
   */
  private async performTraversal(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath && params.sourcePath !== '') {
      throw new Error('Source path is required for traversal operation');
    }

    const options: GraphTraversalOptions = {
      maxDepth: params.maxDepth || 3,
      maxNodes: params.maxNodes || 50,
      includeUnresolved: params.includeUnresolved || false,
      followBacklinks: params.followBacklinks !== false,
      followForwardLinks: params.followForwardLinks !== false,
      followTags: params.followTags || false
    };

    // Add filters if specified
    if (params.fileFilter) {
      const regex = new RegExp(params.fileFilter);
      options.nodeFilter = (node: GraphNode) => regex.test(node.path);
    }

    if (params.folderFilter) {
      options.nodeFilter = (node: GraphNode) => node.path.startsWith(params.folderFilter!);
    }

    const result = await this.graphTraversal.breadthFirstTraversal(params.sourcePath, options);
    
    // Convert to response format
    const nodes = Array.from(result.nodes.values()).map(node => ({
      path: node.path,
      title: node.title,
      type: 'file' as const,
      tags: node.metadata?.tags?.map(t => t.tag),
      links: {
        forward: this.graphTraversal.getForwardLinks(node.path).length,
        backward: this.graphTraversal.getBacklinks(node.path).length,
        total: this.graphTraversal.getForwardLinks(node.path).length + 
               this.graphTraversal.getBacklinks(node.path).length
      }
    }));

    const response: GraphSearchResult = {
      operation: 'traverse',
      sourcePath: params.sourcePath,
      nodes,
      edges: result.edges,
      graphStats: result.stats,
      message: params.sourcePath === '/' || params.sourcePath === ''
        ? `Traversed from ${Math.min(10, this.app.vault.getFiles().length)} most recent files: Found ${result.stats.totalNodes} connected nodes within ${params.maxDepth} degrees`
        : `Found ${result.stats.totalNodes} connected nodes within ${params.maxDepth} degrees of separation`,
      workflow: {
        message: 'Graph traversal complete. You can explore individual nodes or find paths between them.',
        suggested_next: [
          {
            description: 'View a specific file',
            command: 'view:file',
            reason: 'To see the content of any discovered node'
          },
          {
            description: 'Get statistics for a node',
            command: 'graph:statistics',
            reason: 'To see detailed link statistics for a file'
          },
          {
            description: 'Find path between nodes',
            command: 'graph:path',
            reason: 'To find connections between two specific files'
          }
        ]
      }
    };

    return response;
  }

  /**
   * Get immediate neighbors of a node
   */
  private async getNeighbors(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath) {
      throw new Error('Source path is required for neighbors operation');
    }

    const { node, neighbors, edges } = this.graphTraversal.getLocalNeighborhood(params.sourcePath);
    
    const nodes = [node, ...neighbors].map(n => ({
      path: n.path,
      title: n.title,
      type: 'file' as const,
      tags: n.metadata?.tags?.map(t => t.tag),
      links: {
        forward: this.graphTraversal.getForwardLinks(n.path).length,
        backward: this.graphTraversal.getBacklinks(n.path).length,
        total: this.graphTraversal.getForwardLinks(n.path).length + 
               this.graphTraversal.getBacklinks(n.path).length
      }
    }));

    return {
      operation: 'neighbors',
      sourcePath: params.sourcePath,
      nodes,
      edges,
      message: `Found ${neighbors.length} direct neighbors of ${node.title}`,
      workflow: {
        message: 'Local neighborhood retrieved. You can explore connections or expand the search.',
        suggested_next: [
          {
            description: 'Traverse deeper from this node',
            command: 'graph:traverse',
            reason: 'To explore connections beyond immediate neighbors'
          },
          {
            description: 'View file content',
            command: 'view:file',
            reason: 'To examine the content of connected files'
          }
        ]
      }
    };
  }

  /**
   * Find path(s) between two nodes
   */
  private async findPath(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath || !params.targetPath) {
      throw new Error('Both source and target paths are required for path operation');
    }

    // First try shortest path
    const shortestPath = await this.graphTraversal.findShortestPath(
      params.sourcePath,
      params.targetPath,
      { followBacklinks: params.followBacklinks !== false }
    );

    let paths: string[][] = [];
    if (shortestPath) {
      paths.push(shortestPath);
      
      // Optionally find all paths if requested
      if (params.maxDepth && params.maxDepth > shortestPath.length) {
        const allPaths = await this.graphTraversal.findAllPaths(
          params.sourcePath,
          params.targetPath,
          params.maxDepth
        );
        paths = allPaths.slice(0, 10); // Limit to 10 paths
      }
    }

    return {
      operation: 'path',
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
      paths,
      message: paths.length > 0 
        ? `Found ${paths.length} path(s) between files. Shortest path has ${paths[0].length} nodes.`
        : 'No path found between the specified files',
      workflow: {
        message: paths.length > 0 
          ? 'Paths found. You can view the files along any path.'
          : 'No connection found. Try increasing search depth or following backlinks.',
        suggested_next: paths.length > 0 ? [
          {
            description: 'View files in the path',
            command: 'view:file',
            reason: 'To examine the content of files connecting the source and target'
          },
          {
            description: 'Get statistics for path nodes',
            command: 'graph:statistics',
            reason: 'To understand the connectivity of intermediate nodes'
          }
        ] : [
          {
            description: 'Traverse from source with more depth',
            command: 'graph:traverse',
            reason: 'To explore the broader network around the source file'
          }
        ]
      }
    };
  }

  /**
   * Get link statistics for a file
   */
  private async getStatistics(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath) {
      throw new Error('Source path is required for statistics operation');
    }

    const stats = this.graphTraversal.getNodeStatistics(params.sourcePath);
    const file = this.app.vault.getAbstractFileByPath(params.sourcePath);
    
    return {
      operation: 'statistics',
      sourcePath: params.sourcePath,
      statistics: stats,
      message: `Link statistics for ${file?.name || params.sourcePath}`,
      workflow: {
        message: 'Statistics retrieved. You can explore the actual links or find connected nodes.',
        suggested_next: [
          {
            description: 'Get backlinks',
            command: 'graph:backlinks',
            reason: `To see the ${stats.inDegree} files linking to this file`
          },
          {
            description: 'Get forward links',
            command: 'graph:forwardlinks', 
            reason: `To see the ${stats.outDegree} files this file links to`
          },
          {
            description: 'Get neighbors',
            command: 'graph:neighbors',
            reason: 'To see all directly connected files'
          }
        ]
      }
    };
  }

  /**
   * Get backlinks (incoming links) for a file
   */
  private async getBacklinks(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath) {
      throw new Error('Source path is required for backlinks operation');
    }

    const backlinks = this.graphTraversal.getBacklinks(params.sourcePath);
    const nodes: GraphSearchResult['nodes'] = [];
    
    // Get node information for each backlink source
    for (const edge of backlinks) {
      const file = this.app.vault.getAbstractFileByPath(edge.source);
      if (file && file instanceof TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        nodes.push({
          path: edge.source,
          title: file.name.replace(/\.md$/, ''),
          type: 'file',
          tags: cache?.tags?.map(t => t.tag),
          links: {
            forward: this.graphTraversal.getForwardLinks(edge.source).length,
            backward: this.graphTraversal.getBacklinks(edge.source).length,
            total: 0 // Will be calculated
          }
        });
        nodes[nodes.length - 1].links!.total = 
          nodes[nodes.length - 1].links!.forward + nodes[nodes.length - 1].links!.backward;
      }
    }

    return {
      operation: 'backlinks',
      sourcePath: params.sourcePath,
      nodes,
      edges: backlinks,
      message: `Found ${backlinks.length} files linking to this file`,
      workflow: {
        message: 'Backlinks retrieved. You can explore these files or analyze their connections.',
        suggested_next: [
          {
            description: 'View a linking file',
            command: 'view:file',
            reason: 'To see how these files reference the source'
          },
          {
            description: 'Traverse from a backlink',
            command: 'graph:traverse',
            reason: 'To explore the network around files that link here'
          }
        ]
      }
    };
  }

  /**
   * Get forward links (outgoing links) from a file
   */
  private async getForwardLinks(params: GraphSearchParams): Promise<GraphSearchResult> {
    if (!params.sourcePath) {
      throw new Error('Source path is required for forward links operation');
    }

    const forwardLinks = this.graphTraversal.getForwardLinks(params.sourcePath);
    const nodes: GraphSearchResult['nodes'] = [];
    
    // Get node information for each forward link target
    for (const edge of forwardLinks) {
      const file = this.app.vault.getAbstractFileByPath(edge.target);
      if (file && file instanceof TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        nodes.push({
          path: edge.target,
          title: file.name.replace(/\.md$/, ''),
          type: 'file',
          tags: cache?.tags?.map(t => t.tag),
          links: {
            forward: this.graphTraversal.getForwardLinks(edge.target).length,
            backward: this.graphTraversal.getBacklinks(edge.target).length,
            total: 0
          }
        });
        nodes[nodes.length - 1].links!.total = 
          nodes[nodes.length - 1].links!.forward + nodes[nodes.length - 1].links!.backward;
      }
    }

    return {
      operation: 'forwardlinks',
      sourcePath: params.sourcePath,
      nodes,
      edges: forwardLinks,
      message: `Found ${forwardLinks.length} files linked from this file`,
      workflow: {
        message: 'Forward links retrieved. You can explore these referenced files.',
        suggested_next: [
          {
            description: 'View a linked file',
            command: 'view:file',
            reason: 'To see the content of referenced files'
          },
          {
            description: 'Find path to a linked file',
            command: 'graph:path',
            reason: 'To explore alternative connections between files'
          }
        ]
      }
    };
  }
}