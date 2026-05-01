Thank you for reporting this issue! Based on the logs, I can see the server is connecting successfully but the tools aren't appearing in Claude Desktop.

This appears to be related to SSL certificate validation when using HTTPS with the plugin. The solution depends on whether you're using HTTP or HTTPS:

## Solution 1: Using HTTP (Recommended for troubleshooting)
If you're using the HTTP endpoint, your configuration should look like this:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "transport": {
        "type": "http",
        "url": "http://localhost:3001/mcp"
      }
    }
  }
}
```

## Solution 2: Using HTTPS with Self-Signed Certificates
If you're using HTTPS (port 3443), trust the plugin's self-signed certificate properly instead of disabling TLS verification. The certificate is located at `.obsidian/plugins/semantic-vault-mcp/certificates/default.crt` inside your vault.

**macOS Keychain** (for clients that use the system trust store):
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

**For Bun-based runtimes** (Claude Code), set `NODE_EXTRA_CA_CERTS` instead — Bun does not read the macOS system keychain:
```bash
export NODE_EXTRA_CA_CERTS=/path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
launchctl setenv NODE_EXTRA_CA_CERTS /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

Then configure the HTTPS endpoint:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "transport": {
        "type": "http",
        "url": "https://localhost:3443/mcp"
      }
    }
  }
}
```

> **Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0`** — this disables TLS verification process-wide, not just for the plugin. Trust the certificate explicitly instead.

## With API Key Authentication
If you have API key authentication enabled, add the `headers` field to any of the configurations above:
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "transport": {
        "type": "http",
        "url": "https://localhost:3443/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY_HERE"
        }
      }
    }
  }
}
```

> **Important:** Do not use `claude mcp add --header` to register this server — the CLI echoes resolved header values to stdout, exposing your API key. Edit the config file directly instead (`~/.claude/settings.json` for Claude Code, or your client's MCP config file).

For Claude Code, add the config to `~/.claude/settings.json` (user scope) or `.mcp.json` (project scope). Copy the ready-to-use config from the plugin settings page in Obsidian.

Could you please:
1. Confirm which URL you're using (HTTP on port 3001 or HTTPS on port 3443)?
2. Try the appropriate configuration above?
3. Restart your MCP client after updating the configuration

Please let me know if this resolves the issue!
