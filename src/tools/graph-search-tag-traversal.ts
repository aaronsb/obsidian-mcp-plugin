import { App, TFile } from 'obsidian';
import { ObsidianAPI } from '../utils/obsidian-api';
import { SearchCore } from '../utils/search-core';
import { GraphSearchTraversal, TraversalNode, GraphSearchResult } from './graph-search-traversal';

export class GraphSearchTagTraversal extends GraphSearchTraversal {
    constructor(app: App, api: ObsidianAPI, searchCore: SearchCore) {
        super(app, api, searchCore);
    }

    /**
     * Get all linked paths including tag-based connections
     */
    protected getLinkedPathsWithTags(file: TFile, followTags: boolean = true): string[] {
        const linkedPaths = new Set<string>();
        
        // First, get all normal links (forward and back)
        const normalLinks = this.getLinkedPaths(file);
        normalLinks.forEach(path => linkedPaths.add(path));

        // Then, add tag-based connections if enabled
        if (followTags) {
            const tagLinks = this.getTagConnectedPaths(file);
            tagLinks.forEach(path => linkedPaths.add(path));
        }
        
        return Array.from(linkedPaths);
    }

    /**
     * Find all files that share at least one tag with the given file
     */
    private getTagConnectedPaths(file: TFile): string[] {
        const connectedPaths = new Set<string>();
        const cache = this.app.metadataCache.getFileCache(file);
        
        if (!cache?.tags || cache.tags.length === 0) {
            return [];
        }
        
        // Get all tags from this file
        const fileTags = new Set(cache.tags.map(t => t.tag));
        
        // Search through all files to find ones with matching tags
        const allFiles = this.app.vault.getMarkdownFiles();
        for (const otherFile of allFiles) {
            // Skip the same file
            if (otherFile.path === file.path) continue;
            
            const otherCache = this.app.metadataCache.getFileCache(otherFile);
            if (otherCache?.tags) {
                // Check if any tags match
                const hasMatchingTag = otherCache.tags.some(t => fileTags.has(t.tag));
                if (hasMatchingTag) {
                    connectedPaths.add(otherFile.path);
                }
            }
        }
        
        return Array.from(connectedPaths);
    }

    /**
     * Enhanced search traverse that includes tag-based connections
     */
    async searchTraverseWithTags(
        startPath: string,
        searchQuery: string,
        maxDepth: number = 3,
        maxSnippetsPerNode: number = 2,
        scoreThreshold: number = 0.5,
        followTags: boolean = true,
        tagWeight: number = 0.8 // Tags are slightly weaker connections than direct links
    ): Promise<GraphSearchResult & { tagConnections: number }> {
        const startTime = performance.now();
        const visited = new Set<string>();
        const traversalChain: TraversalNode[] = [];
        let totalNodesVisited = 0;
        let tagConnectionsFollowed = 0;

        // Queue items now include connection type
        type QueueItem = [string, number, string | undefined, 'link' | 'tag'];
        const queue: QueueItem[] = [[startPath, 0, undefined, 'link']];
        
        while (queue.length > 0) {
            const [currentPath, depth, parentPath, connectionType] = queue.shift()!;
            
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
            
            // Apply tag weight if this was reached via tag connection
            const adjustedSnippets = connectionType === 'tag' 
                ? snippets.map(s => ({ ...s, score: s.score * tagWeight }))
                : snippets;
            
            // Only include nodes with snippets above threshold
            const highScoreSnippets = adjustedSnippets.filter(s => s.score >= scoreThreshold);
            
            if (highScoreSnippets.length > 0) {
                // Add the best snippet to the traversal chain
                traversalChain.push({
                    path: currentPath,
                    depth,
                    snippet: highScoreSnippets[0],
                    parentPath,
                    connectionType // Add connection type to result
                } as TraversalNode & { connectionType: 'link' | 'tag' });

                // Only continue traversal from nodes with good matches
                if (depth < maxDepth) {
                    // Get both link and tag connections
                    const links = this.getLinkedPathsWithTags(file, followTags);
                    
                    // For each linked path, determine if it's a tag or link connection
                    for (const linkedPath of links) {
                        if (!visited.has(linkedPath)) {
                            // Check if this is a normal link or tag connection
                            const normalLinks = this.getLinkedPaths(file);
                            const isTagConnection = !normalLinks.includes(linkedPath);
                            
                            if (isTagConnection) {
                                tagConnectionsFollowed++;
                            }
                            
                            queue.push([
                                linkedPath, 
                                depth + 1, 
                                currentPath,
                                isTagConnection ? 'tag' : 'link'
                            ]);
                        }
                    }
                }
            }
        }

        const executionTime = performance.now() - startTime;

        return {
            startNode: startPath,
            searchQuery,
            maxDepth,
            traversalChain,
            totalNodesVisited,
            executionTime,
            tagConnections: tagConnectionsFollowed
        };
    }

    /**
     * Get shared tags between two files
     */
    getSharedTags(path1: string, path2: string): string[] {
        const file1 = this.app.vault.getAbstractFileByPath(path1);
        const file2 = this.app.vault.getAbstractFileByPath(path2);
        
        if (!file1 || !file2 || !(file1 instanceof TFile) || !(file2 instanceof TFile)) {
            return [];
        }
        
        const cache1 = this.app.metadataCache.getFileCache(file1);
        const cache2 = this.app.metadataCache.getFileCache(file2);
        
        if (!cache1?.tags || !cache2?.tags) {
            return [];
        }
        
        const tags1 = new Set(cache1.tags.map(t => t.tag));
        const tags2 = new Set(cache2.tags.map(t => t.tag));
        
        return Array.from(tags1).filter(tag => tags2.has(tag));
    }
}