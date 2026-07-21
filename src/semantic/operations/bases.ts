/**
 * Bases operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeBasesOperation. The
 * router passes itself as the RouterContext, so `ctx.api` is the same
 * instance as before.
 */
import { BaseYAML } from '../../types/bases-yaml';
import { RouterContext } from './router-context';
import { Params, paramStr } from './shared';

export async function executeBasesOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
  switch (action) {
    case 'list':
      return await ctx.api.listBases();

    case 'read': {
      const basePath = paramStr(params, 'path');
      if (!basePath) {
        throw new Error('Path parameter is required for reading a base');
      }
      return await ctx.api.readBase(basePath);
    }

    case 'create': {
      const basePath = paramStr(params, 'path');
      const config = params.config as BaseYAML | undefined;
      if (!basePath || !config) {
        throw new Error('Path and config parameters are required for creating a base');
      }
      await ctx.api.createBase(basePath, config);
      return { success: true, path: basePath };
    }

    case 'query': {
      const basePath = paramStr(params, 'path');
      if (!basePath) {
        throw new Error('Path parameter is required for querying a base');
      }
      return await ctx.api.queryBase(basePath, paramStr(params, 'viewName'));
    }

    case 'view': {
      const basePath = paramStr(params, 'path');
      const viewName = paramStr(params, 'viewName');
      if (!basePath || !viewName) {
        throw new Error('Path and viewName parameters are required for getting a base view');
      }
      // View is handled by query with viewName
      return await ctx.api.queryBase(basePath, viewName);
    }

    case 'export': {
      const basePath = paramStr(params, 'path');
      const format = paramStr(params, 'format') as 'csv' | 'json' | 'markdown' | undefined;
      if (!basePath || !format) {
        throw new Error('Path and format parameters are required for exporting a base');
      }
      const exportData = await ctx.api.exportBase(basePath, format, paramStr(params, 'viewName'));
      return {
        success: true,
        data: exportData,
        format
      };
    }

    default:
      throw new Error(`Unknown bases action: ${action}`);
  }
}
