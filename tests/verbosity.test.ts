import { createSemanticTools } from '../src/tools/semantic-tools';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App, TFile, TFolder } from 'obsidian';

// Mock ObsidianAPI
const mockApi = {
    getApp: jest.fn(),
    searchPaginated: jest.fn(),
    getFile: jest.fn(),
    listFiles: jest.fn(),
    getCommands: jest.fn(),
    getServerInfo: jest.fn(),
} as unknown as ObsidianAPI;

// Mock App
const mockApp = {
    vault: {
        getAbstractFileByPath: jest.fn(),
    },
    metadataCache: {
        getFileCache: jest.fn(),
        resolvedLinks: {}
    }
} as unknown as App;

describe('Verbosity Reduction Tests', () => {
    let tools: any[];
    let searchTool: any;
    let readTool: any;

    beforeEach(() => {
        jest.clearAllMocks();
        (mockApi.getApp as jest.Mock).mockReturnValue(mockApp);
        tools = createSemanticTools(mockApi);
        searchTool = tools.find(t => t.name === 'search');
        readTool = tools.find(t => t.name === 'read');
    });

    test('Search response should not contain workflow', async () => {
        (mockApi.searchPaginated as jest.Mock).mockResolvedValue({
            results: [{ path: 'test.md', score: 1 }],
            totalResults: 1
        });

        const result = await searchTool.handler(mockApi, { query: 'test' });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result).toBeDefined();
        expect(parsed.workflow).toBeUndefined();
        expect(parsed.efficiency_hints).toBeUndefined();
        expect(parsed.context).toBeDefined();
        // current_file is undefined for fresh router
        expect(parsed.context.current_file).toBeUndefined();
    });

    test('Read response should not duplicate content', async () => {
        const content = 'File content';
        (mockApi.getFile as jest.Mock).mockResolvedValue(content);
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFile());
        (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({});

        const result = await readTool.handler(mockApi, { path: 'test.md' });
        console.log('Read Result:', result.content[0].text);
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.content).toBe(content);
        // Metadata from file reader (wordCount, warning) is in result.metadata
        expect(parsed.result.metadata).toBeDefined();
        expect(parsed.workflow).toBeUndefined();
    });

    test('Read response should include metadata when requested', async () => {
        const content = 'File content';
        (mockApi.getFile as jest.Mock).mockResolvedValue(content);
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFile());
        (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({
            tags: [{ tag: '#tag1' }]
        });
        (mockApp.metadataCache as any).resolvedLinks = {
            'test.md': { 'linked.md': 1 }
        };

        const result = await readTool.handler(mockApi, { path: 'test.md', includeMetadata: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.metadata).toBeDefined();
        expect(parsed.metadata.tags).toEqual(['#tag1']);
        expect(parsed.metadata.links.outgoing).toContain('linked.md');
    });

    test('Read response should NOT include metadata when includeMetadata is false', async () => {
        const content = 'File content';
        (mockApi.getFile as jest.Mock).mockResolvedValue(content);

        const result = await readTool.handler(mockApi, { path: 'test.md', includeMetadata: false });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.metadata).toBeUndefined();
    });

    test('Context should be minimal', async () => {
        (mockApi.searchPaginated as jest.Mock).mockResolvedValue({ results: [] });

        const result = await searchTool.handler(mockApi, { query: 'test' });
        const parsed = JSON.parse(result.content[0].text);

        // current_file should be undefined for fresh router
        expect(parsed.context.current_file).toBeUndefined();

        // search_history might be present if search was performed
        if (parsed.context.search_history) {
            expect(Object.keys(parsed.context)).toEqual(['search_history']);
        } else {
            expect(Object.keys(parsed.context)).toEqual([]);
        }
    });
});
