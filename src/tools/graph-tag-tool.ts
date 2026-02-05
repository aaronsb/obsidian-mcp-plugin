import { App, TFile } from 'obsidian';
import { ObsidianAPI } from '../utils/obsidian-api';
import { SearchCore } from '../utils/search-core';
import { GraphSearchTagTraversal } from './graph-search-tag-traversal';
import { TraversalNode, GraphSearchResult } from './graph-search-traversal';

interface GraphTagToolParams {
    action: 'tag-traverse' | 'tag-analysis' | 'shared-tags';
    startPath?: string;
    targetPath?: string;
    searchQuery?: string;
    maxDepth?: number;
    maxSnippetsPerNode?: number;
    scoreThreshold?: number;
    followTags?: boolean;
    tagWeight?: number;
}

/** Extended traversal node with connection type info */
interface TagTraversalNode extends TraversalNode {
    connectionType?: 'link' | 'tag';
}

/** Result type from searchTraverseWithTags */
type TagSearchResult = GraphSearchResult & { tagConnections: number; followTags?: boolean };

/** Tag connection strength entry */
interface TagConnectionEntry {
    tag: string;
    connectionCount: number;
}

export class GraphTagTool {
    private graphSearch: GraphSearchTagTraversal;

    constructor(
        private app: App,
        private api: ObsidianAPI
    ) {
        const searchCore = new SearchCore(app);
        this.graphSearch = new GraphSearchTagTraversal(app, api, searchCore);
    }

    async execute(params: GraphTagToolParams): Promise<unknown> {
        switch (params.action) {
            case 'tag-traverse':
                return this.tagTraverse(params);
            case 'tag-analysis':
                return this.analyzeTagConnections(params);
            case 'shared-tags':
                return this.getSharedTags(params);
            default: {
                const exhaustiveCheck: never = params.action;
                throw new Error(`Unknown graph tag action: ${String(exhaustiveCheck)}`);
            }
        }
    }

    private async tagTraverse(params: GraphTagToolParams) {
        if (!params.startPath || !params.searchQuery) {
            throw new Error('startPath and searchQuery are required for tag-traverse action');
        }

        const result = await this.graphSearch.searchTraverseWithTags(
            params.startPath,
            params.searchQuery,
            params.maxDepth,
            params.maxSnippetsPerNode,
            params.scoreThreshold,
            params.followTags !== false, // Default to true
            params.tagWeight || 0.8
        );

        // Format the result for MCP response
        return {
            summary: this.generateSummary(result),
            traversalPath: this.formatTraversalPath(result.traversalChain),
            details: {
                startNode: result.startNode,
                searchQuery: result.searchQuery,
                maxDepth: result.maxDepth,
                totalNodesVisited: result.totalNodesVisited,
                nodesWithMatches: result.traversalChain.length,
                tagConnectionsFollowed: result.tagConnections,
                executionTime: `${result.executionTime.toFixed(2)}ms`
            },
            snippetChain: result.traversalChain.map((node: TraversalNode) => {
                const tagNode = node as TagTraversalNode;
                return {
                    file: tagNode.path,
                    depth: tagNode.depth,
                    parent: tagNode.parentPath,
                    connectionType: tagNode.connectionType || 'link',
                    snippet: {
                        text: tagNode.snippet.text,
                        score: tagNode.snippet.score.toFixed(3),
                        lineNumber: tagNode.snippet.lineNumber,
                        preview: this.truncateText(tagNode.snippet.context, 200)
                    }
                };
            }),
            workflowSuggestions: this.generateWorkflowSuggestions(result)
        };
    }

    private analyzeTagConnections(params: GraphTagToolParams) {
        if (!params.startPath) {
            throw new Error('startPath is required for tag-analysis action');
        }

        // Get the file and its tags
        const file = this.app.vault.getAbstractFileByPath(params.startPath);
        if (!(file instanceof TFile)) {
            throw new Error('File not found or not a valid file');
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const tags = cache?.tags?.map(t => t.tag) || [];

        // Find all files with matching tags
        const tagConnections: Record<string, string[]> = {};
        for (const tag of tags) {
            tagConnections[tag] = [];
        }

        const allFiles = this.app.vault.getMarkdownFiles();
        for (const otherFile of allFiles) {
            if (otherFile.path === params.startPath) continue;
            
            const otherCache = this.app.metadataCache.getFileCache(otherFile);
            if (otherCache?.tags) {
                for (const tag of tags) {
                    if (otherCache.tags.some(t => t.tag === tag)) {
                        tagConnections[tag].push(otherFile.path);
                    }
                }
            }
        }

        return {
            file: params.startPath,
            tags: tags,
            tagConnections: tagConnections,
            summary: `Found ${tags.length} tags connecting to ${Object.values(tagConnections).flat().length} unique files`,
            strongestConnections: this.findStrongestTagConnections(tagConnections)
        };
    }

    private getSharedTags(params: GraphTagToolParams) {
        if (!params.startPath || !params.targetPath) {
            throw new Error('startPath and targetPath are required for shared-tags action');
        }

        const sharedTags = this.graphSearch.getSharedTags(params.startPath, params.targetPath);
        
        return {
            source: params.startPath,
            target: params.targetPath,
            sharedTags: sharedTags,
            connectionStrength: sharedTags.length,
            summary: sharedTags.length > 0 
                ? `Files share ${sharedTags.length} tag(s): ${sharedTags.join(', ')}`
                : 'No shared tags between these files'
        };
    }

    private generateSummary(result: TagSearchResult): string {
        const matchCount = result.traversalChain.length;
        const visitedCount = result.totalNodesVisited;
        const tagConnections = result.tagConnections || 0;

        if (matchCount === 0) {
            return `No matches found for "${result.searchQuery}" after visiting ${visitedCount} notes.`;
        }

        const topScore = result.traversalChain[0]?.snippet.score || 0;
        return `Found ${matchCount} matching notes out of ${visitedCount} visited (${tagConnections} via tags). ` +
               `Best match: "${result.traversalChain[0].path}" (score: ${topScore.toFixed(3)})`;
    }

    private formatTraversalPath(chain: TraversalNode[]): string {
        if (chain.length === 0) return 'No path found';

        return chain
            .map((node: TraversalNode, index: number) => {
                const tagNode = node as TagTraversalNode;
                const indent = '  '.repeat(tagNode.depth);
                const arrow = index === 0 ? '🎯' : tagNode.connectionType === 'tag' ? '🏷️' : '→';
                return `${indent}${arrow} ${tagNode.path}`;
            })
            .join('\n');
    }

    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    private generateWorkflowSuggestions(result: TagSearchResult): string[] {
        const suggestions: string[] = [];
        const tagConnections = result.tagConnections || 0;

        if (result.traversalChain.length === 0) {
            suggestions.push('Try broadening your search query');
            suggestions.push('Lower the score threshold to include more results');
            suggestions.push('Enable tag following to discover more connections');
        } else {
            suggestions.push(`Found ${result.traversalChain.length} connected notes (${tagConnections} via tag bridges)`);

            if (tagConnections === 0 && result.followTags !== false) {
                suggestions.push('No tag connections found - notes may have different tags');
            } else if (tagConnections > 0) {
                suggestions.push(`Tags created ${tagConnections} additional pathways between clusters`);
            }

            if (result.traversalChain.length < 3) {
                suggestions.push('Consider increasing maxDepth to explore deeper connections');
            }
        }

        return suggestions;
    }

    private findStrongestTagConnections(tagConnections: Record<string, string[]>): TagConnectionEntry[] {
        return Object.entries(tagConnections)
            .map(([tag, files]) => ({ tag, connectionCount: files.length }))
            .sort((a, b) => b.connectionCount - a.connectionCount)
            .slice(0, 5);
    }
}