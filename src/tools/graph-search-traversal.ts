import { App, TFile } from 'obsidian';
import { ObsidianAPI } from '../utils/obsidian-api';
import { SearchCore } from '../utils/search-core';

export interface SearchSnippet {
    text: string;
    score: number;
    context: string;
    lineNumber?: number;
}

export interface TraversalNode {
    path: string;
    depth: number;
    snippet: SearchSnippet;
    parentPath?: string;
}

export interface GraphSearchResult {
    startNode: string;
    searchQuery: string;
    maxDepth: number;
    traversalChain: TraversalNode[];
    totalNodesVisited: number;
    executionTime: number;
}

export class GraphSearchTraversal {
    constructor(
        protected app: App,
        protected api: ObsidianAPI,
        protected searchCore: SearchCore
    ) {}

    /**
     * Performs a search-based graph traversal starting from a document
     * 
     * @param startPath - The starting document path
     * @param searchQuery - The search query to apply at each node
     * @param maxDepth - Maximum traversal depth (default: 3)
     * @param maxSnippetsPerNode - Maximum snippets to extract per node (default: 2)
     * @param scoreThreshold - Minimum score threshold for including nodes (default: 0.5)
     */
    async searchTraverse(
        startPath: string,
        searchQuery: string,
        maxDepth: number = 3,
        maxSnippetsPerNode: number = 2,
        scoreThreshold: number = 0.5
    ): Promise<GraphSearchResult> {
        const startTime = performance.now();
        const visited = new Set<string>();
        const traversalChain: TraversalNode[] = [];
        let totalNodesVisited = 0;

        // Handle root path "/" by starting from multiple files
        let initialPaths: [string, number, string | undefined][] = [];

        if (startPath === '/' || startPath === '') {
            // Get all files in the vault
            const allFiles = this.app.vault.getFiles();

            // Sort by modification time to get most relevant files
            const sortedFiles = allFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

            // Take up to 10 most recently modified files as starting points
            const startingFiles = sortedFiles.slice(0, Math.min(10, sortedFiles.length));

            initialPaths = startingFiles.map(file => [file.path, 0, undefined]);
        } else {
            initialPaths = [[startPath, 0, undefined]];
        }

        // Queue for BFS traversal: [path, depth, parentPath]
        const queue: [string, number, string | undefined][] = [...initialPaths];
        
        while (queue.length > 0) {
            const [currentPath, depth, parentPath] = queue.shift()!;
            
            // Skip if already visited or exceeds max depth
            if (visited.has(currentPath) || depth > maxDepth) continue;
            
            visited.add(currentPath);
            totalNodesVisited++;

            // Get the file
            const file = this.app.vault.getAbstractFileByPath(currentPath);
            // Check if it's a file (not a folder) using instanceof
            if (!file || !(file instanceof TFile)) continue;

            // Search within this document
            const snippets = await this.searchInFile(file, searchQuery, maxSnippetsPerNode);
            
            // Only include nodes with snippets above threshold
            const highScoreSnippets = snippets.filter(s => s.score >= scoreThreshold);
            
            if (highScoreSnippets.length > 0) {
                // Add the best snippet to the traversal chain
                traversalChain.push({
                    path: currentPath,
                    depth,
                    snippet: highScoreSnippets[0],
                    parentPath
                });

                // Only continue traversal from nodes with good matches
                if (depth < maxDepth) {
                    const links = this.getLinkedPaths(file);
                    for (const linkedPath of links) {
                        if (!visited.has(linkedPath)) {
                            queue.push([linkedPath, depth + 1, currentPath]);
                        }
                    }
                }
            }
        }

        const executionTime = performance.now() - startTime;

        return {
            startNode: startPath === '/' || startPath === '' ? '/' : startPath,
            searchQuery,
            maxDepth,
            traversalChain,
            totalNodesVisited,
            executionTime
        };
    }

    /**
     * Search for snippets within a file
     */
    protected async searchInFile(file: TFile, query: string, maxSnippets: number): Promise<SearchSnippet[]> {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        const snippets: SearchSnippet[] = [];
        
        // Simple scoring based on query term frequency and position
        const queryTerms = query.toLowerCase().split(/\s+/);
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineLower = line.toLowerCase();
            
            // Calculate score based on how many query terms appear
            let score = 0;
            let matchedTerms = 0;
            
            for (const term of queryTerms) {
                if (lineLower.includes(term)) {
                    matchedTerms++;
                    // Give higher score to exact matches
                    if (lineLower.includes(' ' + term + ' ')) {
                        score += 2;
                    } else {
                        score += 1;
                    }
                }
            }
            
            // Normalize score
            if (matchedTerms > 0) {
                score = score / (queryTerms.length * 2); // Max score of 1.0
                
                // Extract context (surrounding lines)
                const contextStart = Math.max(0, i - 1);
                const contextEnd = Math.min(lines.length - 1, i + 1);
                const context = lines.slice(contextStart, contextEnd + 1).join('\n');
                
                snippets.push({
                    text: line.trim(),
                    score,
                    context,
                    lineNumber: i + 1
                });
            }
        }
        
        // Sort by score and return top snippets
        return snippets
            .sort((a, b) => b.score - a.score)
            .slice(0, maxSnippets);
    }

    /**
     * Get all linked paths from a file (both forward and backlinks)
     */
    protected getLinkedPaths(file: TFile): string[] {
        const linkedPaths = new Set<string>();
        
        // Get forward links
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.links) {
            for (const link of cache.links) {
                const linkedFile = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
                if (linkedFile) {
                    linkedPaths.add(linkedFile.path);
                }
            }
        }
        
        // Get backlinks from resolvedLinks
        const resolvedLinks = this.app.metadataCache.resolvedLinks;
        if (resolvedLinks) {
            // Iterate through all files to find which ones link to this file
            for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
                if (links && links[file.path]) {
                    linkedPaths.add(sourcePath);
                }
            }
        }
        
        return Array.from(linkedPaths);
    }

    /**
     * Advanced traversal with multiple search strategies
     */
    async advancedSearchTraverse(
        startPath: string,
        searchQueries: string[],
        options: {
            maxDepth?: number;
            strategy?: 'breadth-first' | 'best-first' | 'beam-search';
            beamWidth?: number;
            includeOrphans?: boolean;
            followTags?: boolean;
            filePattern?: string;
        } = {}
    ): Promise<GraphSearchResult & { strategies: string[] }> {
        const {
            maxDepth = 3,
            strategy = 'best-first'
        } = options;

        // Implementation would vary based on strategy
        // For now, use the basic search traverse
        const result = await this.searchTraverse(
            startPath,
            searchQueries.join(' '),
            maxDepth
        );

        return {
            ...result,
            strategies: [strategy]
        };
    }
}