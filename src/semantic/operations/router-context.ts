/**
 * RouterContext — the dependency surface a SemanticRouter exposes to the
 * extracted per-operation modules (ADR-202).
 *
 * `SemanticRouter implements RouterContext`, and the router instance itself
 * is passed as the context, so mutations (e.g. of shared state) propagate
 * back to the router without getter/setter indirection.
 *
 * This interface intentionally starts minimal (the members the extracted
 * vault operation touches) and grows as further handlers are extracted in
 * follow-up PRs.
 */
import { App } from 'obsidian';
import { ObsidianAPI } from '../../utils/obsidian-api';
import { UniversalFragmentRetriever } from '../../indexing/fragment-retriever';
import { InputValidator } from '../../validation/input-validator';

export interface RouterContext {
  readonly api: ObsidianAPI;
  readonly app?: App;
  readonly fragmentRetriever: UniversalFragmentRetriever;
  readonly validator: InputValidator;
}
