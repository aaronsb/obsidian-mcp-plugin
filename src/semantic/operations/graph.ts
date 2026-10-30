/**
 * Graph operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeGraphOperation. The
 * three graph tools are built by the router only when it has an App, so
 * each stays optional on the RouterContext and is checked before use.
 */
import { GraphSearchParams } from '../../tools/graph-search';
import { RouterContext } from './router-context';
import { Params, paramStr, paramNum, paramBool } from './shared';

export async function executeGraphOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
  // Handle graph search traversal operations
  if (action === 'search-traverse' || action === 'advanced-traverse') {
    if (!ctx.graphSearchTraversalTool) {
      throw new Error('Graph search traversal operations require Obsidian app context');
    }
    return await ctx.graphSearchTraversalTool.execute({
      action,
      startPath: paramStr(params, 'startPath') ?? '',
      searchQuery: paramStr(params, 'searchQuery'),
      searchQueries: params.searchQueries as string[] | undefined,
      maxDepth: paramNum(params, 'maxDepth'),
      maxSnippetsPerNode: paramNum(params, 'maxSnippetsPerNode'),
      scoreThreshold: paramNum(params, 'scoreThreshold'),
      strategy: paramStr(params, 'strategy') as 'breadth-first' | 'best-first' | 'beam-search' | undefined,
      beamWidth: paramNum(params, 'beamWidth'),
      includeOrphans: paramBool(params, 'includeOrphans'),
      followTags: paramBool(params, 'followTags'),
      filePattern: paramStr(params, 'filePattern')
    });
  }

  // Handle tag-based graph operations
  if (action === 'tag-traverse' || action === 'tag-analysis' || action === 'shared-tags') {
    if (!ctx.graphTagTool) {
      throw new Error('Graph tag operations require Obsidian app context');
    }
    return await ctx.graphTagTool.execute({
      action,
      startPath: paramStr(params, 'startPath'),
      targetPath: paramStr(params, 'targetPath'),
      searchQuery: paramStr(params, 'searchQuery'),
      maxDepth: paramNum(params, 'maxDepth'),
      maxSnippetsPerNode: paramNum(params, 'maxSnippetsPerNode'),
      scoreThreshold: paramNum(params, 'scoreThreshold'),
      followTags: paramBool(params, 'followTags'),
      tagWeight: paramNum(params, 'tagWeight')
    });
  }

  // Handle standard graph operations
  if (!ctx.graphSearchTool) {
    throw new Error('Graph operations require Obsidian app context');
  }

  // Map action to graph operation
  const graphParams: GraphSearchParams = {
    operation: action as GraphSearchParams['operation'],
    sourcePath: paramStr(params, 'sourcePath'),
    targetPath: paramStr(params, 'targetPath'),
    maxDepth: paramNum(params, 'maxDepth'),
    maxNodes: paramNum(params, 'maxNodes'),
    includeUnresolved: paramBool(params, 'includeUnresolved'),
    followBacklinks: paramBool(params, 'followBacklinks'),
    followForwardLinks: paramBool(params, 'followForwardLinks'),
    followTags: paramBool(params, 'followTags'),
    fileFilter: paramStr(params, 'fileFilter'),
    tagFilter: params.tagFilter as string[] | undefined,
    folderFilter: paramStr(params, 'folderFilter')
  };

  return ctx.graphSearchTool.search(graphParams);
}
