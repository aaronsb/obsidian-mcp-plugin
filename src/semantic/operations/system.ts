/**
 * System operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeSystemOperation. The
 * router passes itself as the RouterContext, so `ctx.api` is the same
 * instance as before. A new system action is one more case in the switch.
 */
import { RouterContext } from './router-context';
import { Params } from './shared';

export async function executeSystemOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
  switch (action) {
    case 'info':
      return ctx.api.getServerInfo();
    case 'commands':
      return ctx.api.getCommands();
    case 'fetch_web': {
      // Import fetch tool dynamically
      const { fetchTool } = await import('../../tools/fetch.js');
      return await (fetchTool.handler as unknown as (api: unknown, args: Params) => Promise<unknown>)(ctx.api, params);
    }
    default:
      throw new Error(`Unknown system action: ${action}`);
  }
}
