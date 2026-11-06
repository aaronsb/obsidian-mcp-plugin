/**
 * View operation handler — extracted from router.ts (ADR-202, #199).
 *
 * Behaviour-preserving move of SemanticRouter.executeViewOperation. The
 * router passes itself as the RouterContext, so `ctx.api` is the same
 * instance as before.
 */
import { isImageFile } from '../../types/obsidian';
import { RouterContext } from './router-context';
import { Params, paramStr, paramNum, requireParamStr } from './shared';

export async function executeViewOperation(ctx: RouterContext, action: string, params: Params): Promise<unknown> {
  switch (action) {
    case 'file':
      return await ctx.api.getFile(requireParamStr(params, 'path', 'view.file'));
    case 'window': {
      // View a portion of a file
      const viewPath = requireParamStr(params, 'path', 'view.window');
      const file = await ctx.api.getFile(viewPath);
      if (isImageFile(file)) {
        throw new Error('Cannot view window of image files');
      }
      const content = typeof file === 'string' ? file : file.content;
      const lines = content.split('\n');
      const searchText = paramStr(params, 'searchText');

      let centerLine = paramNum(params, 'lineNumber') || 1;

      // If search text provided, find it
      if (searchText && !params.lineNumber) {
        const { findFuzzyMatches } = await import('../../utils/fuzzy-match.js');
        const matches = findFuzzyMatches(content, searchText, 0.6);
        if (matches.length > 0) {
          centerLine = matches[0].lineNumber;
        }
      }

      // Calculate window
      const windowSize = paramNum(params, 'windowSize') || 20;
      const halfWindow = Math.floor(windowSize / 2);
      const startLine = Math.max(1, centerLine - halfWindow);
      const endLine = Math.min(lines.length, centerLine + halfWindow);

      return {
        path: viewPath,
        lines: lines.slice(startLine - 1, endLine),
        startLine,
        endLine,
        totalLines: lines.length,
        centerLine,
        searchText
      };
    }
      
    case 'active': {
      // Add timeout to prevent hanging when no file is active. The timer is
      // cleared once the lookup settles so no call leaves it pending (#354).
      let timer: number | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Timeout: No active file in Obsidian. Please open a file first.')), 5000);
      });
      try {
        return await Promise.race([
          ctx.api.getActiveFile(),
          timeoutPromise
        ]);
      } finally {
        window.clearTimeout(timer);
      }
    }
      
    case 'open_in_obsidian':
      return await ctx.api.openFile(requireParamStr(params, 'path', 'view.open_in_obsidian'));
      
    default:
      throw new Error(`Unknown view action: ${action}`);
  }
}
