import { App } from 'obsidian';
import { ObsidianAPI } from '../utils/obsidian-api';
import { SearchCore } from '../utils/search-core';
import { GraphSearchTraversal, GraphSearchResult, TraversalNode } from './graph-search-traversal';

interface GraphSearchToolParams {
    action: 'search-traverse' | 'advanced-traverse';
    startPath: string;
    searchQuery?: string;
    searchQueries?: string[];
    maxDepth?: number;
    maxSnippetsPerNode?: number;
    scoreThreshold?: number;
    strategy?: 'breadth-first' | 'best-first' | 'beam-search';
    beamWidth?: number;
    includeOrphans?: boolean;
    followTags?: boolean;
    filePattern?: string;
}

export class GraphSearchTool {
    private graphSearch: GraphSearchTraversal;

    constructor(
        private app: App,
        private api: ObsidianAPI
    ) {
        const searchCore = new SearchCore(app);
        this.graphSearch = new GraphSearchTraversal(app, api, searchCore);
    }

    async execute(params: GraphSearchToolParams): Promise<unknown> {
        switch (params.action) {
            case 'search-traverse':
                return this.searchTraverse(params);
            case 'advanced-traverse':
                return this.advancedTraverse(params);
            default: {
                const exhaustiveCheck: never = params.action;
                throw new Error(`Unknown graph search action: ${String(exhaustiveCheck)}`);
            }
        }
    }

    private async searchTraverse(params: GraphSearchToolParams) {
        if (!params.searchQuery) {
            throw new Error('searchQuery is required for search-traverse action');
        }

        const result = await this.graphSearch.searchTraverse(
            params.startPath,
            params.searchQuery,
            params.maxDepth,
            params.maxSnippetsPerNode,
            params.scoreThreshold
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
                executionTime: `${result.executionTime.toFixed(2)}ms`
            },
            snippetChain: result.traversalChain.map(node => ({
                file: node.path,
                depth: node.depth,
                parent: node.parentPath,
                snippet: {
                    text: node.snippet.text,
                    score: node.snippet.score.toFixed(3),
                    lineNumber: node.snippet.lineNumber,
                    preview: this.truncateText(node.snippet.context, 200)
                }
            })),
            workflowSuggestions: this.generateWorkflowSuggestions(result)
        };
    }

    private async advancedTraverse(params: GraphSearchToolParams) {
        if (!params.searchQueries || params.searchQueries.length === 0) {
            throw new Error('searchQueries array is required for advanced-traverse action');
        }

        const result = await this.graphSearch.advancedSearchTraverse(
            params.startPath,
            params.searchQueries,
            {
                maxDepth: params.maxDepth,
                strategy: params.strategy,
                beamWidth: params.beamWidth,
                includeOrphans: params.includeOrphans,
                followTags: params.followTags,
                filePattern: params.filePattern
            }
        );

        return {
            summary: this.generateSummary(result),
            traversalPath: this.formatTraversalPath(result.traversalChain),
            details: {
                ...result,
                executionTime: `${result.executionTime.toFixed(2)}ms`
            },
            workflowSuggestions: this.generateWorkflowSuggestions(result)
        };
    }

    private generateSummary(result: GraphSearchResult): string {
        const matchCount = result.traversalChain.length;
        const visitedCount = result.totalNodesVisited;

        if (matchCount === 0) {
            return `No matches found for "${result.searchQuery}" after visiting ${visitedCount} notes.`;
        }

        const topScore = result.traversalChain[0]?.snippet.score ?? 0;
        return `Found ${matchCount} matching notes out of ${visitedCount} visited. ` +
               `Best match: "${result.traversalChain[0].path}" (score: ${topScore.toFixed(3)})`;
    }

    private formatTraversalPath(chain: TraversalNode[]): string {
        if (chain.length === 0) return 'No path found';

        return chain
            .map((node, index) => {
                const indent = '  '.repeat(node.depth);
                const arrow = index === 0 ? '🎯' : '→';
                return `${indent}${arrow} ${node.path}`;
            })
            .join('\n');
    }

    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    private generateWorkflowSuggestions(result: GraphSearchResult): string[] {
        const suggestions: string[] = [];

        if (result.traversalChain.length === 0) {
            suggestions.push('Try broadening your search query');
            suggestions.push('Increase the score threshold to include more results');
            suggestions.push('Check if the starting document has any links');
        } else {
            suggestions.push(`Found a knowledge path through ${result.traversalChain.length} connected notes`);

            if (result.traversalChain.length < 3) {
                suggestions.push('Consider increasing maxDepth to explore deeper connections');
            }

            const avgScore = result.traversalChain.reduce((sum: number, node: TraversalNode) =>
                sum + node.snippet.score, 0) / result.traversalChain.length;

            if (avgScore < 0.7) {
                suggestions.push('Matches have moderate scores - consider refining your search query');
            }

            suggestions.push('Use the snippet chain to understand how concepts flow through your notes');
        }

        return suggestions;
    }

    getParameters() {
        return {
            action: {
                type: 'string',
                enum: ['search-traverse', 'advanced-traverse'],
                description: 'The graph search operation to perform'
            },
            startPath: {
                type: 'string',
                description: 'Starting document path for traversal'
            },
            searchQuery: {
                type: 'string',
                description: 'Search query to apply at each node (for search-traverse)'
            },
            searchQueries: {
                type: 'array',
                items: { type: 'string' },
                description: 'Multiple search queries (for advanced-traverse)'
            },
            maxDepth: {
                type: 'number',
                description: 'Maximum traversal depth (default: 3)'
            },
            maxSnippetsPerNode: {
                type: 'number',
                description: 'Maximum snippets to extract per node (default: 2)'
            },
            scoreThreshold: {
                type: 'number',
                description: 'Minimum score threshold for including nodes (0-1, default: 0.5)'
            },
            strategy: {
                type: 'string',
                enum: ['breadth-first', 'best-first', 'beam-search'],
                description: 'Traversal strategy (for advanced-traverse)'
            },
            beamWidth: {
                type: 'number',
                description: 'Beam width for beam-search strategy'
            },
            includeOrphans: {
                type: 'boolean',
                description: 'Include orphaned notes in traversal'
            },
            followTags: {
                type: 'boolean',
                description: 'Follow tag connections in addition to links'
            },
            filePattern: {
                type: 'string',
                description: 'Filter traversal to files matching this pattern'
            }
        };
    }
}