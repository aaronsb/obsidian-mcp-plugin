import { ObsidianAPI } from '../src/utils/obsidian-api';
import { App, TFile } from 'obsidian';

// Mock App and Vault
const mockVault = {
    getAbstractFileByPath: jest.fn(),
    read: jest.fn(),
    modify: jest.fn(),
};

const mockApp = {
    vault: mockVault,
} as unknown as App;

describe('Patch Append Reproduction', () => {
    let api: ObsidianAPI;

    beforeEach(() => {
        jest.clearAllMocks();
        api = new ObsidianAPI(mockApp);
    });

    test('Append to heading should not add extra newlines', async () => {
        const initialContent = `# Heading\nContent`;
        const patchContent = 'New content';

        mockVault.getAbstractFileByPath.mockReturnValue(new TFile());
        mockVault.read.mockResolvedValue(initialContent);

        await api.patchVaultFile('test.md', {
            targetType: 'heading',
            target: 'Heading',
            operation: 'append',
            content: patchContent
        });

        const modifiedContent = mockVault.modify.mock.calls[0][1];
        console.log('Modified Content:\n' + JSON.stringify(modifiedContent));

        // Expected:
        // # Heading
        // Content
        //
        // New content
        const expected = `# Heading\nContent\n\nNew content`;
        expect(modifiedContent).toBe(expected);
    });

    test('Append to heading with existing trailing newline should not add extra newlines', async () => {
        const initialContent = `# Heading\nContent\n`;
        const patchContent = 'New content';

        mockVault.getAbstractFileByPath.mockReturnValue(new TFile());
        mockVault.read.mockResolvedValue(initialContent);

        await api.patchVaultFile('test.md', {
            targetType: 'heading',
            target: 'Heading',
            operation: 'append',
            content: patchContent
        });

        const modifiedContent = mockVault.modify.mock.calls[0][1];
        console.log('Modified Content (Trailing Newline):\n' + JSON.stringify(modifiedContent));

        // Expected:
        // # Heading
        // Content
        //
        // New content
        const expected = `# Heading\nContent\n\nNew content`;
        expect(modifiedContent).toBe(expected);
    });

    test('Append to list should preserve continuity', async () => {
        const initialContent = `# List\n- Item 1`;
        const patchContent = '- Item 2';

        mockVault.getAbstractFileByPath.mockReturnValue(new TFile());
        mockVault.read.mockResolvedValue(initialContent);

        await api.patchVaultFile('test.md', {
            targetType: 'heading',
            target: 'List',
            operation: 'append',
            content: patchContent
        });

        const modifiedContent = mockVault.modify.mock.calls[0][1];
        console.log('Modified Content (List):\n' + JSON.stringify(modifiedContent));

        // Expected:
        // # List
        // - Item 1
        // - Item 2
        //
        // NOT:
        // # List
        // - Item 1
        //
        // - Item 2
        const expected = `# List\n- Item 1\n- Item 2`;
        expect(modifiedContent).toBe(expected);
    });

    test('Append to list with trailing newline should preserve continuity', async () => {
        const initialContent = `# List\n- Item 1\n`;
        const patchContent = '- Item 2';

        mockVault.getAbstractFileByPath.mockReturnValue(new TFile());
        mockVault.read.mockResolvedValue(initialContent);

        await api.patchVaultFile('test.md', {
            targetType: 'heading',
            target: 'List',
            operation: 'append',
            content: patchContent
        });

        const modifiedContent = mockVault.modify.mock.calls[0][1];
        console.log('Modified Content (List with trailing newline):\n' + JSON.stringify(modifiedContent));

        // Expected:
        // # List
        // - Item 1
        // - Item 2
        // (and maybe a trailing newline if we preserve it, but definitely NO blank line between items)

        // If we preserve trailing newline:
        // # List\n- Item 1\n- Item 2\n

        // If we don't:
        // # List\n- Item 1\n- Item 2

        // The key is NO \n\n between Item 1 and Item 2.

        const expected = `# List\n- Item 1\n- Item 2`;
        expect(modifiedContent).toBe(expected);
    });
});
