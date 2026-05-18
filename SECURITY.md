# Security Policy

## Reporting Security Vulnerabilities

We take security seriously. If you discover a security vulnerability, please:

1. **DO NOT** open a public issue
2. **DO** report it via GitHub Security Advisories: [Report a vulnerability](https://github.com/aaronsb/obsidian-mcp-plugin/security/advisories/new)
3. **OR** email details to the maintainer (check commit history for email)

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Known Security Issues

We're actively working on fixing these security vulnerabilities:

| Issue | Status | Priority |
|-------|---------|----------|
| No authentication on MCP server | ✅ Done | CRITICAL |
| Path traversal in file operations | 📋 Planned | CRITICAL |
| Missing input validation | 📋 Planned | HIGH |
| Insecure session management | 📋 Planned | HIGH |

See our [security issues](https://github.com/aaronsb/obsidian-mcp-plugin/issues?q=is%3Aissue+is%3Aopen+label%3Asecurity) for details.

## Security Best Practices

Until security improvements are complete:

1. **Only use on trusted networks** (localhost only)
2. **Don't expose the MCP port** to the internet
3. **Monitor vault access** for unexpected changes
4. **Keep backups** of your vault
5. **Review plugin permissions** in Obsidian
6. **Edit MCP config files directly** instead of using `claude mcp add --header` — the CLI echoes resolved header values to stdout, exposing your API key to parent processes and (on macOS) the unified log

## Secure Configuration

```json
{
  "httpEnabled": true,
  "httpPort": 3001,  // Change from default
  "autoDetectPortConflicts": true,
  "debugLogging": false  // Disable in production
}
```

## Future Security Enhancements

- [x] API key authentication
- [ ] Path validation framework
- [ ] Input sanitization
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Encrypted sessions

## Acknowledgments

Thanks to security researchers who responsibly disclose vulnerabilities.