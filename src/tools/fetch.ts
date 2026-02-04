// Using built-in fetch via globalThis instead of axios
import TurndownService from 'turndown';

/** Arguments for the fetch tool */
interface FetchToolArgs {
  url: string;
  raw?: boolean;
  maxLength?: number;
  startIndex?: number;
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
  handler: async (_: unknown, args: FetchToolArgs) => {
    try {
      const response = await globalThis.fetch(args.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let content = await response.text();

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
      return {
        content: [{
          type: 'text',
          text: `Error fetching URL: ${message}`
        }],
        isError: true
      };
    }
  }
};