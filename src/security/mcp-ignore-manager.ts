import { App } from 'obsidian';
import { Minimatch } from 'minimatch';
import { Debug } from '../utils/debug';

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
  private matchers: Minimatch[] = [];
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
      this.matchers = [];
      this.lastModified = 0;
      Debug.log('MCPIgnore: No .mcpignore file found, no exclusions active');
    }
  }

  /**
   * Parse .gitignore-style content into patterns
   */
  private parseIgnoreContent(content: string): void {
    const lines = content.split('\n');
    const validPatterns: string[] = [];
    const matchers: Minimatch[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Handle negation patterns (!)
      let pattern = trimmed;
      let negate = false;
      if (pattern.startsWith('!')) {
        negate = true;
        pattern = pattern.substring(1);
      }

      try {
        // Create minimatch instance with gitignore-compatible options
        const matcher = new Minimatch(pattern, {
          dot: true,           // Match files starting with .
          nobrace: false,      // Enable {a,b} expansion
          noglobstar: false,   // Enable ** patterns
          noext: false,        // Enable extended matching
          nonegate: false,     // Allow negation
          flipNegate: negate   // Handle ! prefix
        });

        validPatterns.push(trimmed);
        matchers.push(matcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Debug.log(`MCPIgnore: Invalid pattern "${trimmed}": ${message}`);
      }
    }

    this.patterns = validPatterns;
    this.matchers = matchers;
  }

  /**
   * Check if a file path should be excluded
   * @param path - File path relative to vault root
   * @returns true if path should be excluded
   */
  isExcluded(path: string): boolean {
    Debug.log(`🔍 MCPIgnore.isExcluded called with path: "${path}"`);
    
    if (!this.isEnabled || this.matchers.length === 0) {
      Debug.log(`🔍 MCPIgnore: disabled or no matchers (enabled: ${this.isEnabled}, matchers: ${this.matchers.length})`);
      return false;
    }

    // Normalize path (remove leading slash, use forward slashes)
    const normalizedPath = path.replace(/^\/+/, '').replace(/\\/g, '/');
    Debug.log(`🔍 MCPIgnore: normalized path "${path}" -> "${normalizedPath}"`);
    
    let excluded = false;
    
    // Process patterns in order - later patterns can override earlier ones
    Debug.log(`🔍 MCPIgnore: checking ${this.matchers.length} patterns against "${normalizedPath}"`);
    for (let i = 0; i < this.matchers.length; i++) {
      const matcher = this.matchers[i];
      let isMatch = matcher.match(normalizedPath);
      
      // .gitignore directory patterns: "dir/" should match "dir" and "dir/anything"
      if (!isMatch && matcher.pattern.endsWith('/')) {
        // Try matching without the trailing slash for the directory itself
        const dirPattern = matcher.pattern.slice(0, -1);
        const dirMatcher = new Minimatch(dirPattern, matcher.options);
        isMatch = dirMatcher.match(normalizedPath);
        Debug.log(`🔍 MCPIgnore: directory pattern fallback "${dirPattern}" -> match: ${isMatch}`);
      }
      
      Debug.log(`🔍 MCPIgnore: pattern ${i+1}: "${matcher.pattern}" (negate: ${matcher.negate}) -> match: ${isMatch}`);
      
      if (matcher.negate) {
        // Negation pattern - include if it matches
        if (isMatch) {
          excluded = false;
          Debug.log(`🔍 MCPIgnore: negation pattern matched, setting excluded = false`);
        }
      } else {
        // Normal pattern - exclude if it matches
        if (isMatch) {
          excluded = true;
          Debug.log(`🔍 MCPIgnore: normal pattern matched, setting excluded = true`);
        }
      }
    }

    Debug.log(`🔍 MCPIgnore: final result for "${normalizedPath}": excluded = ${excluded}`);
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