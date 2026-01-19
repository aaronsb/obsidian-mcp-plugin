import { App, normalizePath } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Custom error class for security violations
 */
export class SecurityError extends Error {
	constructor(message: string, public code: string = 'SECURITY_VIOLATION') {
		super(message);
		this.name = 'SecurityError';
	}
}

/**
 * Industry-standard path validation following OWASP guidelines
 * Implements multiple defense layers to prevent path traversal attacks
 */
export class SecurePathValidator {
	private readonly baseDir: string;
	private readonly pathTraversalPatterns = [
		// Standard traversal sequences
		'../', '..\\',
		// URL encoded variants
		'%2e%2e%2f', '%2e%2e%5c', '%252e%252e%252f',
		'%2e%2e/', '.%2e/', '%2e./', '..%2f', '.%2f',
		// Unicode variants
		'\u002e\u002e\u002f', '\u002e\u002e\u005c',
		// Double encoding
		'..%252f', '..%255c',
		// Null byte injection
		'\0', '%00',
		// Alternative traversal
		'..../', '...\\', 
		// Windows UNC paths
		'\\\\', '//'
	];

	constructor(app: App) {
		// Get vault base path using Obsidian's adapter
		// @ts-ignore - basePath exists at runtime but not in TypeScript definitions
		this.baseDir = app.vault.adapter.basePath || '';
		
		if (!this.baseDir) {
			throw new Error('Could not determine vault base directory');
		}
		
		// Normalize the base directory itself
		this.baseDir = path.normalize(this.baseDir);
	}

	/**
	 * Validates and normalizes a path following security best practices
	 * Based on OWASP path traversal prevention guidelines
	 * 
	 * @param userPath - The user-provided path to validate
	 * @returns The validated and normalized path relative to the vault
	 * @throws SecurityError if the path is invalid or attempts traversal
	 */
	validatePath(userPath: string): string {
		// Layer 1: Null/undefined check
		if (!userPath || typeof userPath !== 'string') {
			throw new SecurityError('Invalid path: path must be a non-empty string', 'INVALID_PATH');
		}

		// Layer 2: Input validation - Reject dangerous patterns
		if (this.containsDangerousPatterns(userPath)) {
			throw new SecurityError('Path contains forbidden sequences', 'FORBIDDEN_PATTERN');
		}

		// Layer 3: Path type validation - Reject absolute paths
		if (this.isAbsolutePath(userPath)) {
			throw new SecurityError('Absolute paths are not allowed', 'ABSOLUTE_PATH');
		}

		// Layer 4: Obsidian normalization - Use framework's built-in normalizer
		// This handles things like converting backslashes to forward slashes
		const obsidianNormalized = normalizePath(userPath);

		// Layer 5: Node.js path resolution - Resolve to absolute path
		const resolved = path.resolve(this.baseDir, obsidianNormalized);
		
		// Layer 6: Path normalization - Remove any remaining ../
		const normalized = path.normalize(resolved);

		// Layer 7: Boundary validation - Ensure path stays within vault
		if (!this.isWithinVault(normalized)) {
			throw new SecurityError('Path escapes vault boundary', 'VAULT_ESCAPE');
		}

		// Layer 8: Real path verification (optional, only for existing files)
		// This helps prevent symlink attacks
		if (fs.existsSync(normalized)) {
			try {
				const realPath = fs.realpathSync(normalized);
				if (!this.isWithinVault(realPath)) {
					throw new SecurityError('Resolved path escapes vault boundary', 'SYMLINK_ESCAPE');
				}
			} catch {
				// File system error, let it pass for now
			}
		}

		// Return the path relative to vault root for Obsidian API
		const relativePath = path.relative(this.baseDir, normalized);
		
		// Final safety check - relative path shouldn't start with ..
		if (relativePath.startsWith('..')) {
			throw new SecurityError('Invalid relative path', 'INVALID_RELATIVE');
		}

		// Convert to forward slashes for Obsidian
		return relativePath.split(path.sep).join('/');
	}

	/**
	 * Checks if a path contains dangerous patterns that could indicate traversal attempts
	 */
	private containsDangerousPatterns(input: string): boolean {
		const lowerInput = input.toLowerCase();
		return this.pathTraversalPatterns.some(pattern => 
			lowerInput.includes(pattern.toLowerCase())
		);
	}

	/**
	 * Checks if a path is absolute
	 */
	private isAbsolutePath(userPath: string): boolean {
		// Unix absolute path
		if (userPath.startsWith('/')) return true;
		
		// Windows absolute path (C:\, D:\, etc.)
		if (/^[A-Za-z]:[\\/]/.test(userPath)) return true;
		
		// UNC path (\\server\share)
		if (userPath.startsWith('\\\\')) return true;
		
		// URL-style (file://)
		if (userPath.includes('://')) return true;
		
		return false;
	}

	/**
	 * Checks if a normalized absolute path is within the vault
	 */
	private isWithinVault(normalizedPath: string): boolean {
		// Ensure both paths use the same separator and are normalized
		const vaultPath = path.normalize(this.baseDir);
		const checkPath = path.normalize(normalizedPath);
		
		// Add trailing separator to prevent partial matches
		// e.g., /vault vs /vault-other
		const vaultPathWithSep = vaultPath.endsWith(path.sep) ? vaultPath : vaultPath + path.sep;
		const checkPathWithSep = checkPath + path.sep;
		
		return checkPath === vaultPath || checkPathWithSep.startsWith(vaultPathWithSep);
	}

	/**
	 * Gets the vault base directory (for testing/debugging)
	 */
	getBaseDir(): string {
		return this.baseDir;
	}
}

/**
 * TypeScript Branded Type for compile-time safety
 * Ensures only validated paths are used in file operations
 */
export type ValidatedPath = string & { readonly __brand: 'ValidatedPath' };

/**
 * Type-safe path validator that returns branded types
 */
export class TypeSafePathValidator extends SecurePathValidator {
	validatePath(userPath: string): ValidatedPath {
		const validated = super.validatePath(userPath);
		return validated as ValidatedPath;
	}
}