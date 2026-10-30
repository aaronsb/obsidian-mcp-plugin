/**
 * workflow operation — router dispatch (#199 stage 2, operations/workflow.ts).
 *
 * Characterization tests: written against the router before
 * executeWorkflowOperation moved out of router.ts, and kept unchanged across
 * the move. workflow.suggest reads the router's context tracking, so these
 * run through SemanticRouter.route, which records `path` and `query` before
 * dispatch. There was no router-level test for the workflow operation before
 * this extraction.
 */
import { SemanticRouter } from '../src/semantic/router';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App } from 'obsidian';

function setup() {
  return new SemanticRouter(new ObsidianAPI({} as App));
}

describe('workflow operation dispatch (router -> operations/workflow.ts)', () => {
  it('suggest with no context offers the default suggestion', async () => {
    const response = await setup().route({ operation: 'workflow', action: 'suggest', params: {} });
    expect(response.result).toEqual({
      current_context: {
        current_file: undefined,
        current_directory: undefined,
        buffer_available: false,
        file_history: undefined,
        search_history: undefined,
        has_file_content: undefined,
        has_links: false,
        has_tags: false,
        search_results_available: undefined,
        linked_files: undefined,
        tags: undefined
      },
      suggestions: [{
        description: 'Use workflow hints from other operations',
        command: 'vault(action="list") or vault(action="read", path="...") etc.',
        reason: 'Each operation provides contextual workflow suggestions'
      }]
    });
  });

  it('suggest builds on the last file and the last search', async () => {
    const response = await setup().route({
      operation: 'workflow',
      action: 'suggest',
      params: { path: 'notes/a.md', query: 'tag:#x' }
    });
    const result = response.result as { current_context: Record<string, unknown>; suggestions: unknown[] };
    expect(result.suggestions).toEqual([
      {
        description: 'Continue working with last file',
        command: "vault(action='read', path='notes/a.md')",
        reason: 'Return to previous work'
      },
      {
        description: 'Refine last search',
        command: "vault(action='search', query='tag:#x AND ...')",
        reason: 'Narrow down results'
      }
    ]);
    expect(result.current_context.current_file).toBe('notes/a.md');
    expect(result.current_context.file_history).toEqual(['notes/a.md']);
    expect(result.current_context.search_history).toEqual(['tag:#x']);
  });

  it('suggest refines the most recent of several searches', async () => {
    // route() records `query` from any operation before dispatch.
    const router = setup();
    await router.route({ operation: 'workflow', action: 'suggest', params: { query: 'first' } });
    const response = await router.route({ operation: 'workflow', action: 'suggest', params: { query: 'second' } });
    const result = response.result as { suggestions: Array<{ command: string }> };
    expect(result.suggestions.map((s) => s.command)).toEqual([
      "vault(action='search', query='second AND ...')"
    ]);
  });

  it('an unknown action is rejected', async () => {
    const response = await setup().route({ operation: 'workflow', action: 'nope', params: {} });
    expect(response.error?.message).toBe('Unknown workflow action: nope');
  });
});
