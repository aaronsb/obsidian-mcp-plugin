# Testing Guide

This guide covers how to test the Obsidian MCP Plugin locally, both using automated tests and manual testing within Obsidian.

## Automated Tests

The project uses Jest for automated testing.

### Running All Tests
To run all tests, execute:
```bash
npm test
```

### Running Specific Tests
To run a specific test file, use `npx jest`:
```bash
npx jest tests/vault-tools.test.ts
```

### Test Structure
- `tests/` contains all test files.
- `tests/setup.ts` handles test environment setup.
- Mocks are located in `tests/__mocks__`.

## Manual Testing in Obsidian

To test the plugin within Obsidian, you need to build it and install it into a local vault.

### 1. Build the Plugin
Run the build command to generate `main.js`:
```bash
npm run build
```
For development with auto-rebuild on changes:
```bash
npm run dev
```

### 2. Install in a Local Vault
1.  Create a new vault in Obsidian (e.g., `TestVault`).
2.  Navigate to the vault's plugin directory:
    ```bash
    cd /path/to/TestVault/.obsidian/plugins/
    ```
    *Note: You may need to create the `.obsidian/plugins` directory if it doesn't exist.*
3.  Create a directory for this plugin:
    ```bash
    mkdir obsidian-mcp-plugin
    ```
4.  Copy the built files to this directory. From the root of the repository:
    ```bash
    cp main.js manifest.json styles.css /path/to/TestVault/.obsidian/plugins/obsidian-mcp-plugin/
    ```

    **Tip:** You can create a symbolic link to avoid copying files every time you build:
    ```bash
    ln -s /absolute/path/to/repo/main.js /path/to/TestVault/.obsidian/plugins/obsidian-mcp-plugin/main.js
    ln -s /absolute/path/to/repo/manifest.json /path/to/TestVault/.obsidian/plugins/obsidian-mcp-plugin/manifest.json
    ln -s /absolute/path/to/repo/styles.css /path/to/TestVault/.obsidian/plugins/obsidian-mcp-plugin/styles.css
    ```

### 3. Enable the Plugin
1.  Open Obsidian and load your `TestVault`.
2.  Go to **Settings > Community Plugins**.
3.  Turn off **Restricted Mode**.
4.  Find "Semantic MCP" (or "Obsidian MCP Plugin") in the list of installed plugins and enable it.

### 4. Connect an MCP Client
Configure your MCP client (like Claude Desktop) to connect to the local server.

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "obsidian-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```
*Note: Ensure the plugin is running and the server is started (check the plugin settings in Obsidian).*
