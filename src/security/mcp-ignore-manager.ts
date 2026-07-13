import { App } from 'obsidian';
import { Minimatch } from 'minimatch';
import { Debug } from '../utils/debug';

/**
 * One .mcpignore line, compiled. `matchers` are the globs that together implement the
 * source pattern's gitignore semantics (see expandPattern); the rule matches a path if
 * any of them does.
 */
interface IgnoreRule {
  negate: boolean;
  matchers: Minimatch[];
}

/**
 * MCPIgnoreManager - Handles .mcpignore file-based path exclusions
 *
 * Uses .gitignore-style patterns to exclude files and directories from MCP operations.
 * Patterns are stored in .mcpignore at the vault root (like .gitignore)
 */
export class MCPIgnoreManager {
  private app: App;
  private ignorePath: string;
  private patterns: string[] = [];
  private rules: IgnoreRule[] = [];
  private isEnabled: boolean = false;
  private lastModified: number = 0;

  constructor(app: App) {
    this.app = app;
    this.ignorePath = '.mcpignore';
  }

  /**
   * Enable or disable path exclusions
   */
  setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    if (enabled) {
      void this.loadIgnoreFile();
    }
  }

  /**
   * Check if path exclusions are enabled
   */
  getEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Load and parse the .mcpignore file
   */
  async loadIgnoreFile(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const adapter = this.app.vault.adapter;
      const stat = await adapter.stat(this.ignorePath);
      
      // Only reload if file has been modified
      if (stat && stat.mtime === this.lastModified) {
        return;
      }

      const content = await adapter.read(this.ignorePath);
      this.parseIgnoreContent(content);
      this.lastModified = stat?.mtime || Date.now();
      
      Debug.log(`MCPIgnore: Loaded ${this.patterns.length} exclusion patterns`);
    } catch {
      // File doesn't exist or can't be read - no exclusions
      this.patterns = [];
      this.rules = [];
      this.lastModified = 0;
      Debug.log('MCPIgnore: No .mcpignore file found, no exclusions active');
    }
  }

  /**
   * Translate one .gitignore pattern into the minimatch globs that implement it.
   *
   * Minimatch is a glob matcher, not a gitignore matcher, so handing it a raw pattern
   * silently under-blocks. Two gitignore rules have to be expanded explicitly:
   *
   *  - A pattern with no internal '/' matches at ANY depth ('*.secret' hides
   *    'a/b/creds.secret'), whereas the bare glob only matches the top level.
   *  - A directory match also covers everything beneath it ('private/' hides
   *    'private/notes.md'). Nothing downstream re-checks ancestors — every caller of
   *    isExcluded() passes a full file path — so the contents must be matched here or
   *    they are not excluded at all.
   *
   * Returns the globs for the pattern; a path matches the pattern if it matches any.
   */
  private expandPattern(pattern: string): string[] {
    let p = pattern;

    // 'dir/' is directory-only in gitignore. We cannot stat here, so we treat the name
    // as matching whether it is a file or a folder; the contents glob below is what
    // actually does the work for directories.
    if (p.endsWith('/')) {
      p = p.slice(0, -1);
    }

    // A leading '/' anchors to the vault root; an internal '/' anchors too. Only a
    // pattern with no separator at all is depth-agnostic.
    const rootAnchored = p.startsWith('/');
    if (rootAnchored) {
      p = p.replace(/^\/+/, '');
    }

    const base = rootAnchored || p.includes('/') ? p : `**/${p}`;

    // The second glob excludes the contents when `base` names a directory. It is inert
    // for a plain file, since no path can be nested under one.
    return [base, `${base}/**`];
  }

  /**
   * Parse .gitignore-style content into patterns
   */
  private parseIgnoreContent(content: string): void {
    const validPatterns: string[] = [];
    const rules: IgnoreRule[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Negation is handled here rather than by Minimatch: the pattern is rewritten
      // below, so the '!' would not survive to reach it anyway.
      const negate = trimmed.startsWith('!');
      const body = negate ? trimmed.slice(1) : trimmed;
      if (!body) {
        continue;
      }

      try {
        const matchers = this.expandPattern(body).map(glob => new Minimatch(glob, {
          dot: true,           // Match files starting with .
          nobrace: false,      // Enable {a,b} expansion
          noglobstar: false,   // Enable ** patterns
          noext: false,        // Enable extended matching
          nonegate: true       // '!' is ours to interpret, not Minimatch's
        }));

        validPatterns.push(trimmed);
        rules.push({ negate, matchers });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Debug.log(`MCPIgnore: Invalid pattern "${trimmed}": ${message}`);
      }
    }

    this.patterns = validPatterns;
    this.rules = rules;
  }

  /**
   * Check if a file path should be excluded
   * @param path - File path relative to vault root
   * @returns true if path should be excluded
   */
  isExcluded(path: string): boolean {
    if (!this.isEnabled || this.rules.length === 0) {
      return false;
    }

    // Normalize path (remove leading slash, use forward slashes)
    const normalizedPath = path.replace(/^\/+/, '').replace(/\\/g, '/');

    // Last matching rule wins, so a later negation can re-include an earlier exclusion.
    let excluded = false;

    for (const rule of this.rules) {
      if (rule.matchers.some(matcher => matcher.match(normalizedPath))) {
        excluded = !rule.negate;
      }
    }

    Debug.log(`🔍 MCPIgnore: "${normalizedPath}" excluded = ${excluded}`);
    return excluded;
  }

  /**
   * Get current exclusion patterns
   */
  getPatterns(): string[] {
    return [...this.patterns];
  }

  /**
   * Get statistics about current exclusions
   */
  getStats(): {
    enabled: boolean;
    patternCount: number;
    lastModified: number;
    filePath: string;
  } {
    return {
      enabled: this.isEnabled,
      patternCount: this.patterns.length,
      lastModified: this.lastModified,
      filePath: this.ignorePath
    };
  }

  /**
   * Create a default .mcpignore file template
   */
  async createDefaultIgnoreFile(): Promise<void> {
    const template = `# MCP Plugin Exclusions
# Syntax: https://git-scm.com/docs/gitignore
# Lines starting with # are comments
# Use ! to negate/whitelist patterns

# === PATTERN EXAMPLES ===
# 
# DIRECTORIES:
# private/              # Excludes 'private' directory and ALL its contents
# /private/             # Only excludes 'private' at vault root (not nested)
# private               # Excludes any file or directory named 'private'
#
# WILDCARDS:
# *.secret              # All files ending with .secret in any directory
# secret.*              # All files starting with 'secret.' in any directory
# *secret*              # Any file containing 'secret' in the name
#
# SPECIFIC PATHS:
# daily/2024-01-15.md   # Excludes this specific file only
# daily/*.md            # All .md files directly in daily/ (not subdirectories)
# daily/**/*.md         # All .md files in daily/ and ALL subdirectories
# daily/**/secret.md    # Files named secret.md in daily/ or any subdirectory
#
# NESTED PATTERNS:
# work/*/confidential/  # Excludes 'confidential' dirs one level under work/
# work/**/confidential/ # Excludes ALL 'confidential' dirs under work/
# **/temp/              # Excludes ALL directories named 'temp' anywhere
# 
# COMPLEX PATTERNS:
# archive/202[0-9]/**   # All content in archive/2020 through 2029
# logs/*/debug-*.log    # Debug logs one level deep in logs/
# !logs/*/debug-keep.log # But keep this specific debug log

# === COMMON USE CASES (remove # to activate) ===

# Private/Personal content
# private/
# personal/
# journal/
# diary/

# Work separation
# work/confidential/
# clients/*/contracts/
# company-internal/**

# Temporary files
# *.tmp
# *.backup
# *.bak
# ~*
# .#*

# Development/Testing
# test/
# sandbox/
# experiments/**/*.draft

# Media files (if desired)
# *.mp4
# *.mov
# attachments/videos/

# === WHITELIST EXCEPTIONS ===
# Use ! to include files that would otherwise be excluded
# !private/shared-notes.md
# !work/public-docs/
# !**/*.public.md

# === YOUR PATTERNS BELOW ===
# Add your custom exclusion patterns here

`;

    try {
      await this.app.vault.adapter.write(this.ignorePath, template);
      Debug.log(`MCPIgnore: Created default .mcpignore file at ${this.ignorePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Debug.log(`MCPIgnore: Failed to create .mcpignore file: ${message}`);
      throw error;
    }
  }

  /**
   * Check if .mcpignore file exists
   */
  async ignoreFileExists(): Promise<boolean> {
    try {
      // Force fresh check - no caching
      const stat = await this.app.vault.adapter.stat(this.ignorePath);
      return stat !== null && stat !== undefined;
    } catch {
      // File doesn't exist
      Debug.log(`MCPIgnore: File check for ${this.ignorePath} - does not exist`);
      return false;
    }
  }

  /**
   * Filter an array of file paths, removing excluded ones
   */
  filterPaths(paths: string[]): string[] {
    if (!this.isEnabled) return paths;
    return paths.filter(path => !this.isExcluded(path));
  }

  /**
   * Force reload the ignore file (for manual refresh)
   */
  async forceReload(): Promise<void> {
    this.lastModified = 0;
    await this.loadIgnoreFile();
  }
}