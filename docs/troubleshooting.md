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
1. **Check API key**: Ensure the key in your client config matches the one shown in plugin settings
2. **Check config location**: For Claude Code, the config lives in `~/.claude/settings.json` (user scope) or `.mcp.json` (project scope). Verify the `headers.Authorization` value is `Bearer <your key>` (note the space after Bearer)
3. **Regenerated key**: The API key regenerates on plugin updates — copy the new key from settings and update your config file
4. **Don't use `claude mcp add --header`**: it echoes the resolved token to stdout and (on macOS) the unified log. Edit the config file directly instead

## SSL Certificate Errors

**Symptoms:**
Certificate warnings, TLS handshake failures, or silent connection failures when using HTTPS. The failure is often silent server-side — the handshake aborts before the HTTP request is sent, so the plugin's debug log shows nothing. Bun-based clients can fail this way even after trusting the cert in Keychain Access, because **Bun does not consult the macOS system keychain for TLS trust**.

**Solution:**
Trust the plugin's self-signed certificate properly. See [Trusting the self-signed certificate](../README.md#trusting-the-self-signed-certificate) in the README for the full instructions, covering:

- **macOS Keychain** (`security add-trusted-cert`) — for clients that use the system trust store.
- **`NODE_EXTRA_CA_CERTS`** — required for Bun-based runtimes; set via `launchctl setenv` so dock-launched GUI apps inherit it.

The cert is auto-generated on first start under `.obsidian/plugins/semantic-vault-mcp/certificates/default.crt` inside your vault; re-trust it whenever the plugin regenerates it.

**Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0`:** it disables TLS verification process-wide — not just for the plugin — and masks legitimate certificate problems (expired, revoked, tampered) instead of fixing them.

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
