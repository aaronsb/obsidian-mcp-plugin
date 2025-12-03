import { createSemanticTools } from '../src/tools/semantic-tools';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { SemanticRouter } from '../src/semantic/router';

// Mock SemanticRouter
jest.mock('../src/semantic/router');

describe('Granular Vault Tools', () => {
    let mockApi: jest.Mocked<ObsidianAPI>;
    let mockRouter: jest.Mocked<SemanticRouter>;

    beforeEach(() => {
        mockApi = {
            getApp: jest.fn().mockReturnValue({
                plugins: {
                    enabledPlugins: new Set()
                }
            }),
            plugin: {
                settings: {
                    readOnlyMode: false
                }
            }
        } as any;

        mockRouter = {
            route: jest.fn().mockResolvedValue({ result: 'success' })
        } as any;

        (SemanticRouter as jest.Mock).mockImplementation(() => mockRouter);
    });

    it('should create granular tools instead of monolithic vault tool', () => {
        const tools = createSemanticTools(mockApi);
        const toolNames = tools.map(t => t.name);

        expect(toolNames).toContain('list');
        expect(toolNames).toContain('read');
        expect(toolNames).toContain('create');
        expect(toolNames).toContain('update');
        expect(toolNames).toContain('delete');
        expect(toolNames).not.toContain('vault');
    });

    it('should delegate "list" tool to router with operation="vault" and action="list"', async () => {
        const tools = createSemanticTools(mockApi);
        const listTool = tools.find(t => t.name === 'list');

        await listTool.handler(mockApi, { directory: '/' });

        expect(SemanticRouter).toHaveBeenCalledWith(mockApi, mockApi.getApp());
        expect(mockRouter.route).toHaveBeenCalledWith({
            operation: 'vault',
            action: 'list',
            params: { directory: '/' }
        });
    });

    it('should delegate "read" tool to router with operation="vault" and action="read"', async () => {
        const tools = createSemanticTools(mockApi);
        const readTool = tools.find(t => t.name === 'read');

        // Return an object result to satisfy isImageFileObject check
        mockRouter.route.mockResolvedValueOnce({ result: { content: 'success' } });

        await readTool.handler(mockApi, { path: 'note.md' });

        expect(mockRouter.route).toHaveBeenCalledWith({
            operation: 'vault',
            action: 'read',
            params: { path: 'note.md' }
        });
    });

    it('should block write operations in read-only mode', async () => {
        (mockApi as any).plugin.settings.readOnlyMode = true;
        const tools = createSemanticTools(mockApi);
        const createTool = tools.find(t => t.name === 'create');

        const result = await createTool.handler(mockApi, { path: 'new.md', content: 'test' });

        expect(JSON.parse(result.content[0].text).error.code).toBe('READ_ONLY_MODE');
        expect(mockRouter.route).not.toHaveBeenCalled();
    });
});
