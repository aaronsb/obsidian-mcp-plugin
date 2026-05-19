Thank you for reporting this issue! Based on the logs, the server is connecting but the tools aren't appearing in your client.

This is almost always MCP transport configuration or SSL certificate trust. Modern MCP clients speak HTTP transport natively — you no longer need the `mcp-remote` bridge.

## Solution 1: Using HTTP (recommended for troubleshooting)

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

## Solution 2: Using HTTPS with the self-signed certificate

If you're using HTTPS (port 3443), **trust the plugin's self-signed certificate** rather than disabling TLS verification. The cert is at `.obsidian/plugins/semantic-vault-mcp/certificates/default.crt` inside your vault.

**macOS Keychain** (clients that use the system trust store):
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \
  /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

**Bun-based runtimes (Claude Code)** — Bun does not read the macOS keychain, so set `NODE_EXTRA_CA_CERTS` instead:
```bash
export NODE_EXTRA_CA_CERTS=/path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
launchctl setenv NODE_EXTRA_CA_CERTS /path/to/vault/.obsidian/plugins/semantic-vault-mcp/certificates/default.crt
```

Then point the config at the HTTPS endpoint:
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

> **Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0`** — it disables TLS verification process-wide, not just for the plugin. Trust the certificate explicitly instead.

## With API key authentication

Add a `headers` field to any of the configs above:
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

> For **Claude Code** specifically, the simplest path is one command — no manual JSON editing:
> ```bash
> claude mcp add --transport http obsidian https://localhost:3443/mcp --header "Authorization: Bearer YOUR_API_KEY_HERE"
> ```
> (Use `http://localhost:3001/mcp` if you're on HTTP.) The plugin's Settings tab has the ready-made command with your key filled in.

Could you please:
1. Confirm which URL you're using (HTTP on 3001 or HTTPS on 3443)?
2. Try the appropriate configuration above?
3. Restart your MCP client after updating the configuration?

Please let me know if this resolves the issue!
