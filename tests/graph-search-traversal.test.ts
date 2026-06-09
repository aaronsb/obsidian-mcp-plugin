import { GraphSearchTraversal } from '../src/tools/graph-search-traversal';
import { App, TFile } from 'obsidian';
import { ObsidianAPI } from '../src/utils/obsidian-api';
import { SearchCore } from '../src/utils/search-core';

// Mock implementations
const mockApp = {
    vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        search: jest.fn()
    },
    metadataCache: {
        getFileCache: jest.fn(),
        getFirstLinkpathDest: jest.fn(),
        resolvedLinks: {} as any
    }
} as unknown as App;

const mockAPI = { getIgnoreManager: () => undefined } as unknown as ObsidianAPI;
const mockSearchCore = new SearchCore(mockApp);

describe('GraphSearchTraversal', () => {
    let traversal: GraphSearchTraversal;

    beforeEach(() => {
        traversal = new GraphSearchTraversal(mockApp, mockAPI, mockSearchCore);
        jest.clearAllMocks();
    });

    describe('searchTraverse', () => {
        it('should traverse graph and return snippet chain', async () => {
            // Mock file structure
            const mockFile1 = Object.create(TFile.prototype);
            Object.assign(mockFile1, { path: 'note1.md', extension: 'md', name: 'note1.md' });
            
            const mockFile2 = Object.create(TFile.prototype);
            Object.assign(mockFile2, { path: 'note2.md', extension: 'md', name: 'note2.md' });
            
            // Mock vault methods
            mockApp.vault.getAbstractFileByPath = jest.fn()
                .mockReturnValueOnce(mockFile1)
                .mockReturnValueOnce(mockFile2);
            
            mockApp.vault.read = jest.fn()
                .mockResolvedValueOnce('This is a test document about search algorithms')
                .mockResolvedValueOnce('Another document discussing search techniques');
            
            // Mock metadata for links
            mockApp.metadataCache.getFileCache = jest.fn().mockReturnValue({
                links: [{ link: 'note2.md' }]
            });
            
            mockApp.metadataCache.getFirstLinkpathDest = jest.fn()
                .mockReturnValue(mockFile2);
            
            // Mock backlinks using resolvedLinks instead
            mockApp.metadataCache.resolvedLinks = {};
            
            // Execute traversal
            const result = await traversal.searchTraverse(
                'note1.md',
                'search',
                2,
                1,
                0.3
            );
            
            // Verify results
            expect(result.startNode).toBe('note1.md');
            expect(result.searchQuery).toBe('search');
            expect(result.traversalChain).toHaveLength(2);
            expect(result.traversalChain[0].path).toBe('note1.md');
            expect(result.traversalChain[0].depth).toBe(0);
            expect(result.traversalChain[0].snippet.score).toBeGreaterThan(0);
            expect(result.totalNodesVisited).toBe(2);
        });

        it('should respect score threshold', async () => {
            const mockFile = Object.create(TFile.prototype);
            Object.assign(mockFile, { path: 'note1.md', extension: 'md', name: 'note1.md' });
            
            mockApp.vault.getAbstractFileByPath = jest.fn().mockReturnValue(mockFile);
            mockApp.vault.read = jest.fn().mockResolvedValue('This document has no relevant content');
            mockApp.metadataCache.getFileCache = jest.fn().mockReturnValue({ links: [] });
            mockApp.metadataCache.resolvedLinks = {};
            
            const result = await traversal.searchTraverse(
                'note1.md',
                'quantum physics',
                2,
                1,
                0.8 // High threshold
            );
            
            expect(result.traversalChain).toHaveLength(0);
            expect(result.totalNodesVisited).toBe(1);
        });

        it('should handle circular references', async () => {
            const mockFile1 = Object.create(TFile.prototype);
            Object.assign(mockFile1, { path: 'note1.md', extension: 'md', name: 'note1.md' });
            
            const mockFile2 = Object.create(TFile.prototype);
            Object.assign(mockFile2, { path: 'note2.md', extension: 'md', name: 'note2.md' });
            
            // Create circular reference
            mockApp.vault.getAbstractFileByPath = jest.fn()
                .mockReturnValueOnce(mockFile1)
                .mockReturnValueOnce(mockFile2);
            
            mockApp.vault.read = jest.fn()
                .mockResolvedValue('This contains the search term');
            
            // note1 links to note2
            mockApp.metadataCache.getFileCache = jest.fn()
                .mockReturnValueOnce({ links: [{ link: 'note2.md' }] })
                .mockReturnValueOnce({ links: [{ link: 'note1.md' }] }); // circular
            
            mockApp.metadataCache.getFirstLinkpathDest = jest.fn()
                .mockReturnValueOnce(mockFile2)
                .mockReturnValueOnce(mockFile1);
            
            mockApp.metadataCache.resolvedLinks = {};
            
            const result = await traversal.searchTraverse(
                'note1.md',
                'search',
                3,
                1,
                0.3
            );
            
            // Should visit each file only once
            expect(result.totalNodesVisited).toBe(2);
            const paths = result.traversalChain.map(n => n.path);
            expect(new Set(paths).size).toBe(paths.length); // No duplicates
        });
    });
});