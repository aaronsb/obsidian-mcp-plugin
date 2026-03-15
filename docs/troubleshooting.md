# Troubleshooting

Common issues and solutions for the Obsidian MCP Plugin.

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
3. **Regenerated key**: The API key regenerates on plugin updates — copy the new key from settings

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

## n8n Integration

**Symptoms:**
n8n MCP tool reports "unable to connect" or expects SSE endpoint.

**Cause:**
Older versions of n8n only support SSE (Server-Sent Events) transport, while this plugin uses Streamable HTTP transport (the newer MCP standard).

**Solution:**
Update n8n to the latest version which supports Streamable HTTP transport.

**Configuration:**
```
MCP URL: http://<your-ip>:3001/mcp
```

Ensure the plugin is enabled and the server is running (check the status bar in Obsidian).

## Still Having Issues?

- Check [GitHub Issues](https://github.com/aaronsb/obsidian-mcp-plugin/issues) for known problems
- Open a new issue with:
  - OS and version
  - Obsidian version
  - Plugin version
  - AI client being used
  - Error messages from Developer Tools console
