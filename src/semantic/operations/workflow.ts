/**
 * Workflow operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeWorkflowOperation and
 * generateWorkflowSuggestions, its only caller's helper. Suggestions are
 * built from the router's context snapshot (getCurrentContext), which
 * reflects what route() recorded before dispatch.
 */
import { SuggestedAction } from '../../types/semantic';
import { ContextSnapshot, RouterContext } from './router-context';
import { Params } from './shared';

export function executeWorkflowOperation(ctx: RouterContext, action: string, _params: Params): unknown {
  switch (action) {
    case 'suggest':
      return generateWorkflowSuggestions(ctx);
    default:
      throw new Error(`Unknown workflow action: ${action}`);
  }
}

function generateWorkflowSuggestions(ctx: RouterContext): { current_context: ContextSnapshot; suggestions: SuggestedAction[] } {
  // Generate contextual workflow suggestions based on current state
  const current = ctx.getCurrentContext();
  const suggestions: SuggestedAction[] = [];
  
  if (current.current_file) {
    suggestions.push({
      description: 'Continue working with last file',
      command: `vault(action='read', path='${current.current_file}')`,
      reason: 'Return to previous work'
    });
  }
  
  if (current.search_history?.length) {
    const lastSearch = current.search_history[current.search_history.length - 1];
    suggestions.push({
      description: 'Refine last search',
      command: `vault(action='search', query='${lastSearch} AND ...')`,
      reason: 'Narrow down results'
    });
  }
  
  // Always include a default suggestion if no context-specific ones
  if (suggestions.length === 0) {
    suggestions.push({
      description: 'Use workflow hints from other operations',
      command: 'vault(action="list") or vault(action="read", path="...") etc.',
      reason: 'Each operation provides contextual workflow suggestions'
    });
  }
  
  return {
    current_context: current,
    suggestions
  };
}
