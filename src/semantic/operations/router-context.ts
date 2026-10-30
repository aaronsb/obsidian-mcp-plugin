/**
 * RouterContext — the dependency surface a SemanticRouter exposes to the
 * extracted per-operation modules (ADR-202).
 *
 * `SemanticRouter implements RouterContext`, and the router instance itself
 * is passed as the context, so mutations (e.g. of shared state) propagate
 * back to the router without getter/setter indirection.
 *
 * Each member is here because an extracted handler touches it; a handler
 * that needs something new adds it here when it moves.
 */
import { App } from 'obsidian';
import { ObsidianAPI } from '../../utils/obsidian-api';
import { UniversalFragmentRetriever } from '../../indexing/fragment-retriever';
import { InputValidator } from '../../validation/input-validator';
import { GraphSearchTool } from '../../tools/graph-search';
import { GraphSearchTool as GraphSearchTraversalTool } from '../../tools/graph-search-tool';
import { GraphTagTool } from '../../tools/graph-tag-tool';

export interface RouterContext {
  readonly api: ObsidianAPI;
  readonly app?: App;
  readonly fragmentRetriever: UniversalFragmentRetriever;
  readonly validator: InputValidator;
  // Built only when the router has an App; absent otherwise.
  readonly graphSearchTool?: GraphSearchTool;
  readonly graphSearchTraversalTool?: GraphSearchTraversalTool;
  readonly graphTagTool?: GraphTagTool;
}
