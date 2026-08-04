import TurndownService from 'turndown';
import { safeFetch, OutboundFetchError } from '../security';

/** Arguments for the fetch tool */
interface FetchToolArgs {
  url: string;
  raw?: boolean;
  maxLength?: number;
  startIndex?: number;
}

/** Minimal plugin shape for reading the enableWebFetch setting live */
interface PluginWithWebFetchSetting {
  settings?: {
    enableWebFetch?: boolean;
  };
}

export const fetchTool = {
  name: 'fetch',
  description: 'Fetch and convert web content to markdown',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from'
      },
      raw: {
        type: 'boolean',
        description: 'Return raw HTML instead of converting to markdown (default: false)',
        default: false
      },
      maxLength: {
        type: 'number',
        description: 'Maximum content length to return (optional)'
      },
      startIndex: {
        type: 'number',
        description: 'Starting index for content pagination (optional)'
      }
    },
    required: ['url']
  },
  handler: async (api: unknown, args: FetchToolArgs) => {
    // Live predicate (ADR-108 pattern): the security layer consults the
    // setting per call; enumeration hiding elsewhere is presentation only.
    const plugin = (api as { plugin?: PluginWithWebFetchSetting } | undefined)?.plugin;
    const isEnabled = () => plugin?.settings?.enableWebFetch === true;

    try {
      // ADR-109: every hop is validated against the outbound policy and the
      // connection pinned to the validated address.
      const response = await safeFetch(args.url, isEnabled);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let content = response.body;

      if (!args.raw && typeof content === 'string' && content.includes('<')) {
        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced'
        });
        content = turndown.turndown(content);
      }

      if (args.startIndex || args.maxLength) {
        const start: number = args.startIndex || 0;
        const end: number | undefined = args.maxLength ? start + args.maxLength : undefined;
        content = content.slice(start, end);
      }

      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof OutboundFetchError ? error.code : undefined;
      return {
        content: [{
          type: 'text',
          text: code ? `Error fetching URL [${code}]: ${message}` : `Error fetching URL: ${message}`
        }],
        isError: true
      };
    }
  }
};
