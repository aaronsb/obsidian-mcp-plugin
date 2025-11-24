import { createSemanticTools } from '../src/tools/semantic-tools';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App, TFile, TFolder } from 'obsidian';

// Mock ObsidianAPI
const mockApi = {
    getApp: jest.fn(),
    getFile: jest.fn(),
    createFile: jest.fn(),
    deleteFile: jest.fn(),
    updateFile: jest.fn(),
    listFiles: jest.fn(),
    listFilesPaginated: jest.fn(),
} as unknown as ObsidianAPI;

// Mock App
const mockApp = {
    vault: {
        getAbstractFileByPath: jest.fn(),
    },
    fileManager: {
        renameFile: jest.fn(),
    }
} as unknown as App;

describe('File Manipulation Verbosity Tests', () => {
    let tools: any[];
    let moveTool: any;
    let renameTool: any;
    let splitTool: any;
    let combineTool: any;
    let copyTool: any;

    beforeEach(() => {
        jest.clearAllMocks();
        (mockApi.getApp as jest.Mock).mockReturnValue(mockApp);
        tools = createSemanticTools(mockApi);
        moveTool = tools.find(t => t.name === 'move');
        renameTool = tools.find(t => t.name === 'rename');
        splitTool = tools.find(t => t.name === 'split');
        combineTool = tools.find(t => t.name === 'combine');
        copyTool = tools.find(t => t.name === 'copy');
    });

    test('Move response should not contain workflow', async () => {
        (mockApi.getFile as jest.Mock).mockResolvedValue({ content: 'content' });
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFile());

        const result = await moveTool.handler(mockApi, {
            action: 'move',
            path: 'source.md',
            destination: 'dest.md'
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
    });

    test('Rename response should not contain workflow', async () => {
        (mockApi.getFile as jest.Mock).mockResolvedValue({ content: 'content' });
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new TFile());

        const result = await renameTool.handler(mockApi, {
            action: 'rename',
            path: 'old.md',
            newName: 'new.md'
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
    });

    test('Split response should not contain workflow', async () => {
        (mockApi.getFile as jest.Mock).mockResolvedValue({ content: 'line1\nline2' });

        const result = await splitTool.handler(mockApi, {
            action: 'split',
            path: 'test.md',
            splitBy: 'lines',
            linesPerFile: 1
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
        expect(parsed.result.createdFiles).toBeDefined();
    });

    test('Combine response should not contain workflow', async () => {
        (mockApi.getFile as jest.Mock).mockResolvedValue({ content: 'content' });

        const result = await combineTool.handler(mockApi, {
            action: 'combine',
            paths: ['file1.md', 'file2.md'],
            destination: 'combined.md'
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
        expect(parsed.result.filesCombined).toBe(2);
    });

    test('Copy file response should not contain workflow', async () => {
        (mockApi.getFile as jest.Mock).mockResolvedValue({ content: 'content' });

        const result = await copyTool.handler(mockApi, {
            action: 'copy',
            path: 'source.md',
            destination: 'copy.md'
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
        expect(parsed.result.copiedTo).toBe('copy.md');
    });

    test('Copy directory response should not contain workflow', async () => {
        // Mock listFiles to throw so it tries directory copy
        (mockApi.listFiles as jest.Mock).mockRejectedValue(new Error('Not a directory'));
        // Mock listFilesPaginated for the recursive copy
        (mockApi.listFilesPaginated as jest.Mock).mockResolvedValue({
            files: [
                { path: 'dir/file1.md', type: 'file' }
            ]
        });

        // We need to simulate the router logic:
        // 1. copyFile calls getFile(path). If it fails, it catches.
        // 2. Then it calls listFiles(path). If it succeeds, it calls copyDirectoryRecursive.

        // So getFile(path) must fail.
        (mockApi.getFile as jest.Mock)
            .mockRejectedValueOnce(new Error('Not a file')) // First call fails (source path)
            .mockResolvedValue({ content: 'content' }); // Subsequent calls (files inside dir) succeed

        // listFiles(path) must succeed
        (mockApi.listFiles as jest.Mock).mockResolvedValue(['dir/file1.md']);

        const result = await copyTool.handler(mockApi, {
            action: 'copy',
            path: 'dir',
            destination: 'dir_copy'
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.result.success).toBe(true);
        expect(parsed.workflow).toBeUndefined();
        expect(parsed.result.filesCount).toBeDefined();
    });
});
