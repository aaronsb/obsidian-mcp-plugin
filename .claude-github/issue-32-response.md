Thank you for reporting this issue! Based on the logs, I can see the server is connecting successfully but the tools aren't appearing in Claude Desktop.

This appears to be related to SSL certificate validation when using HTTPS with the plugin. The solution depends on whether you're using HTTP or HTTPS:

## Solution 1: Using HTTP (Recommended for troubleshooting)
If you're using the HTTP endpoint, your configuration should look like this:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3001/mcp"
      ]
    }
  }
}
```

## Solution 2: Using HTTPS with Self-Signed Certificates
If you're using HTTPS (port 3443), you need to add the `NODE_TLS_REJECT_UNAUTHORIZED` environment variable:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://localhost:3443/mcp"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

## With API Key Authentication
If you have API key authentication enabled, use this format:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://localhost:3443/mcp",
        "--header",
        "Authorization:${AUTH}"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "AUTH": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Could you please:
1. Confirm which URL you're using (HTTP on port 3001 or HTTPS on port 3443)?
2. Try the appropriate configuration above?
3. Restart Claude Desktop after updating the configuration

The `NODE_TLS_REJECT_UNAUTHORIZED` environment variable is crucial when using HTTPS with self-signed certificates, as Claude Desktop needs to bypass certificate validation for local development certificates.

Please let me know if this resolves the issue!