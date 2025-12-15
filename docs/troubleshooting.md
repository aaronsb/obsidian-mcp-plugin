# Troubleshooting

Common issues and solutions for the Obsidian MCP Plugin.

## Windows: "Program is not recognized" Error

**Symptoms:**
When connecting Claude Desktop to the MCP server on Windows, you may see:
```
'D:\Program' is not recognized as an internal or external command, operable program or batch file.
```

**Cause:**
This occurs when Node.js is installed in a path containing spaces (e.g., `D:\Program Files\nodejs\`). Claude Desktop resolves `npx` to its full path but doesn't properly quote it when spawning the process, causing Windows to interpret `D:\Program` as the command.

**Solution:**
Use the full path to `npx.cmd` from your npm global directory instead of just `npx`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "C:\\Users\\YOUR_USERNAME\\AppData\\Roaming\\npm\\npx.cmd",
      "args": ["mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```

**With Authentication:**
```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "C:\\Users\\YOUR_USERNAME\\AppData\\Roaming\\npm\\npx.cmd",
      "args": [
        "mcp-remote",
        "https://localhost:3443/mcp",
        "--header",
        "Authorization:${AUTH}"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0",
        "AUTH": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

**Alternative Solutions:**
1. **DOS 8.3 short names**: Use `D:\PROGRA~1\nodejs\npx.cmd` (varies by system)
2. **Reinstall Node.js** to a path without spaces (e.g., `C:\nodejs\`)

**Note:** This is a known issue with Claude Desktop's handling of Windows paths. The npm global directory solution is the most reliable workaround.

## Connection Refused

**Symptoms:**
AI client cannot connect to the MCP server.

**Solutions:**
1. **Check plugin is enabled**: Settings → Community plugins → Semantic MCP should be enabled
2. **Verify server is running**: Look for the MCP status indicator in Obsidian's status bar
3. **Check port availability**: Default ports are 3001 (HTTP) and 3443 (HTTPS)
4. **Firewall**: Ensure your firewall allows local connections on these ports

## Authentication Errors

**Symptoms:**
Connection works but requests are rejected with 401/403 errors.

**Solutions:**
1. **Check API key**: Ensure the key in your client config matches the one in plugin settings
2. **Header format**: Use `Authorization: Bearer YOUR_KEY` (note the space after Bearer)
3. **HTTPS required**: Authentication only works over HTTPS (port 3443 by default)

## SSL Certificate Errors

**Symptoms:**
Certificate warnings or connection failures when using HTTPS.

**Solutions:**
1. **For development**: Set `NODE_TLS_REJECT_UNAUTHORIZED=0` in your client config
2. **Self-signed certs**: The plugin generates self-signed certificates on first run
3. **Certificate location**: Certificates are stored in the plugin's data folder

## Server Not Starting

**Symptoms:**
MCP status bar shows error or server doesn't respond.

**Solutions:**
1. **Port conflict**: Another application may be using ports 3001/3443. Change ports in plugin settings.
2. **Check console**: Open Developer Tools (Ctrl+Shift+I) and check for error messages
3. **Restart plugin**: Disable and re-enable the plugin in Community plugins settings

## Dataview/Bases Not Working

**Symptoms:**
Dataview queries or Bases operations return errors.

**Solutions:**
1. **Install required plugins**: Dataview and/or Bases plugins must be installed and enabled
2. **Wait for indexing**: After opening a vault, wait for plugins to finish indexing
3. **Query syntax**: Ensure DQL queries are properly formatted

## Performance Issues

**Symptoms:**
Slow responses or timeouts.

**Solutions:**
1. **Large vault**: Enable pagination in search results
2. **Complex queries**: Use more specific search terms
3. **Graph traversal**: Limit depth for large, highly-connected vaults
4. **Debug logging**: Disable debug logging in production (Settings → Semantic MCP)

## Still Having Issues?

- Check [GitHub Issues](https://github.com/aaronsb/obsidian-mcp-plugin/issues) for known problems
- Open a new issue with:
  - OS and version
  - Obsidian version
  - Plugin version
  - AI client being used
  - Error messages from Developer Tools console
