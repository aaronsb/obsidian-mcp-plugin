import { App } from 'obsidian';
import { SecurePathValidator, SecurityError, ValidatedPath } from './path-validator';
import { Debug } from '../utils/debug';
import { MCPIgnoreManager } from './mcp-ignore-manager';

/**
 * Operation types matching CRUD + special operations
 */
export enum OperationType {
	// CRUD operations
	READ = 'read',        // R - getFile, listFiles, fragments
	CREATE = 'create',    // C - createFile
	UPDATE = 'update',    // U - updateFile, appendToFile, patchFile  
	DELETE = 'delete',    // D - deleteFile
	
	// Special operations
	MOVE = 'move',        // moveFile
	RENAME = 'rename',    // renameFile
	COPY = 'copy',        // copyFile
	EXECUTE = 'execute'   // openFile (opens in Obsidian)
}

/**
 * Security settings interface
 */
export interface SecuritySettings {
	// Path validation
	pathValidation: 'strict' | 'moderate' | 'disabled';
	allowedPaths?: string[];  // Whitelist specific paths/patterns
	blockedPaths?: string[];  // Blacklist specific paths/patterns
	
	// Operation permissions (addresses issue #15)
	permissions: {
		read: boolean;      // R in CRUD
		create: boolean;    // C in CRUD  
		update: boolean;    // U in CRUD
		delete: boolean;    // D in CRUD
		move: boolean;      // Special operations
		rename: boolean;
		execute: boolean;   // Opening files in Obsidian
	};
	
	// Advanced options
	logSecurityEvents: boolean;
	notifyOnBlocked: boolean;
	rateLimitEnabled?: boolean;
	sandboxMode?: string; // Restrict to specific folder
}

/**
 * Default security settings - secure by default
 */
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
	pathValidation: 'strict',
	permissions: {
		read: true,
		create: true,
		update: true,
		delete: true,
		move: true,
		rename: true,
		execute: true
	},
	logSecurityEvents: true,
	notifyOnBlocked: true
};

/**
 * Vault operation descriptor
 */
export interface VaultOperation {
	type: OperationType;
	path?: string;
	targetPath?: string; // For move/rename operations
	context?: {
		method?: string;
		contentSize?: number;
		[key: string]: unknown;
	};
}

/**
 * Validated operation result
 */
export interface ValidatedOperation extends VaultOperation {
	path?: ValidatedPath;
	targetPath?: ValidatedPath;
	validatedAt: number;
}

/**
 * Security audit log entry
 */
export interface SecurityLogEntry {
	timestamp: number;
	operation: VaultOperation;
	result: 'allowed' | 'blocked';
	reason?: string;
	error?: string;
}

/**
 * Central security manager for vault operations
 * Handles both path validation and operation permissions
 */
export class VaultSecurityManager {
	private validator: SecurePathValidator;
	private settings: SecuritySettings;
	private auditLog: SecurityLogEntry[] = [];
	private readonly maxLogEntries = 1000;
	private ignoreManager?: MCPIgnoreManager;

	constructor(app: App, settings: Partial<SecuritySettings> = {}, ignoreManager?: MCPIgnoreManager) {
		this.validator = new SecurePathValidator(app);
		this.settings = { ...DEFAULT_SECURITY_SETTINGS, ...settings };
		this.ignoreManager = ignoreManager;
		Debug.log(`VaultSecurityManager initialized with ignoreManager: ${!!ignoreManager}`);
	}

	/**
	 * Single entry point for ALL vault operations
	 * Validates both permissions and paths
	 */
	async validateOperation(operation: VaultOperation): Promise<ValidatedOperation> {
		Debug.log(`🔐 VaultSecurityManager.validateOperation called for: ${operation.type} on "${operation.path}"`);
		try {
			// Step 1: Check if security is enabled
			if (this.settings.pathValidation === 'disabled') {
				// Still check permissions even if path validation is disabled
				if (!this.isOperationAllowed(operation.type)) {
					throw new SecurityError(
						`Operation '${operation.type}' is not permitted`,
						'PERMISSION_DENIED'
					);
				}
				
				// Return operation as-is without path validation
				// Cast paths to ValidatedPath since we're bypassing validation
				const result = {
					...operation,
					validatedAt: Date.now()
				};
				
				if (operation.path) {
					result.path = operation.path as ValidatedPath;
				}
				if (operation.targetPath) {
					result.targetPath = operation.targetPath as ValidatedPath;
				}
				
				return result as ValidatedOperation;
			}

			// Step 2: Check operation permission
			if (!this.isOperationAllowed(operation.type)) {
				this.logSecurityEvent(operation, 'blocked', 'PERMISSION_DENIED');
				throw new SecurityError(
					`Operation '${operation.type}' is not permitted in current security mode`,
					'PERMISSION_DENIED'
				);
			}

			// Step 3: Validate paths if present
			let validatedPath: ValidatedPath | undefined;
			let validatedTargetPath: ValidatedPath | undefined;

			if (operation.path) {
				// Check if path is in blocked list
				if (this.isPathBlocked(operation.path)) {
					this.logSecurityEvent(operation, 'blocked', 'PATH_BLOCKED');
					throw new SecurityError(
						`Access to path '${operation.path}' is blocked`,
						'PATH_BLOCKED'
					);
				}

				// Validate path security
				validatedPath = this.validator.validatePath(operation.path) as ValidatedPath;

				// Check if validated path is in allowed list (if specified)
				if (!this.isPathAllowed(validatedPath)) {
					this.logSecurityEvent(operation, 'blocked', 'PATH_NOT_ALLOWED');
					throw new SecurityError(
						`Access to path '${validatedPath}' is not allowed`,
						'PATH_NOT_ALLOWED'
					);
				}
			}

			// Step 4: Validate target path for move/rename operations
			if (operation.targetPath) {
				if (this.isPathBlocked(operation.targetPath)) {
					this.logSecurityEvent(operation, 'blocked', 'TARGET_PATH_BLOCKED');
					throw new SecurityError(
						`Access to target path '${operation.targetPath}' is blocked`,
						'TARGET_PATH_BLOCKED'
					);
				}

				validatedTargetPath = this.validator.validatePath(operation.targetPath) as ValidatedPath;

				if (!this.isPathAllowed(validatedTargetPath)) {
					this.logSecurityEvent(operation, 'blocked', 'TARGET_PATH_NOT_ALLOWED');
					throw new SecurityError(
						`Access to target path '${validatedTargetPath}' is not allowed`,
						'TARGET_PATH_NOT_ALLOWED'
					);
				}
			}

			// Build the validated operation
			const validated: ValidatedOperation = {
				...operation,
				path: validatedPath,
				targetPath: validatedTargetPath,
				validatedAt: Date.now()
			};

			// Step 5: Check sandbox mode
			if (this.settings.sandboxMode) {
				this.validateSandboxPath(validated);
			}

			// Step 6: Log successful validation
			this.logSecurityEvent(validated, 'allowed');

			return validated;
		} catch (error) {
			// Log any errors that aren't already logged
			if (!(error instanceof SecurityError)) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logSecurityEvent(operation, 'blocked', 'UNKNOWN_ERROR', errorMessage);
			}
			throw error;
		}
	}

	/**
	 * Checks if an operation type is allowed
	 */
	private isOperationAllowed(type: OperationType): boolean {
		const perms = this.settings.permissions;
		
		switch (type) {
			case OperationType.READ:
				return perms.read;
			case OperationType.CREATE:
				return perms.create;
			case OperationType.UPDATE:
				return perms.update;
			case OperationType.DELETE:
				return perms.delete;
			case OperationType.MOVE:
				return perms.move;
			case OperationType.RENAME:
				return perms.rename;
			case OperationType.COPY:
				return perms.create && perms.read; // Copy requires both
			case OperationType.EXECUTE:
				return perms.execute;
			default:
				return false;
		}
	}

	/**
	 * Checks if a path is in the blocked list
	 */
	private isPathBlocked(path: string): boolean {
		Debug.log(`🔍 Checking if path is blocked: "${path}"`);
		
		// Always block access to .mcpignore file itself for security
		if (path === '.mcpignore' || path === '/.mcpignore') {
			Debug.log(`Path blocked - .mcpignore file is protected: ${path}`);
			return true;
		}

		// Check .mcpignore patterns if available
		Debug.log(`🔍 .mcpignore check - ignoreManager: ${!!this.ignoreManager}, enabled: ${this.ignoreManager?.getEnabled()}`);
		if (this.ignoreManager && this.ignoreManager.getEnabled()) {
			const isExcluded = this.ignoreManager.isExcluded(path);
			Debug.log(`🔍 .mcpignore exclusion check for "${path}": ${isExcluded}`);
			if (isExcluded) {
				Debug.log(`Path blocked by .mcpignore: ${path}`);
				return true;
			}
		}

		// Then check blockedPaths setting
		Debug.log(`🔍 blockedPaths check - array: ${JSON.stringify(this.settings.blockedPaths)}`);
		if (!this.settings.blockedPaths || this.settings.blockedPaths.length === 0) {
			Debug.log(`🔍 No blockedPaths configured, path "${path}" is not blocked`);
			return false;
		}

		const isBlockedBySettings = this.settings.blockedPaths.some(pattern => 
			this.matchesPattern(path, pattern)
		);
		Debug.log(`🔍 blockedPaths pattern match result for "${path}": ${isBlockedBySettings}`);
		
		return isBlockedBySettings;
	}

	/**
	 * Checks if a path is in the allowed list (if specified)
	 */
	private isPathAllowed(path: string): boolean {
		// If no allowed paths specified, all paths are allowed
		if (!this.settings.allowedPaths || this.settings.allowedPaths.length === 0) {
			return true;
		}

		return this.settings.allowedPaths.some(pattern => 
			this.matchesPattern(path, pattern)
		);
	}

	/**
	 * Simple pattern matching (supports * wildcard)
	 */
	private matchesPattern(path: string, pattern: string): boolean {
		// Convert pattern to regex
		const regexPattern = pattern
			.replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
			.replace(/\*/g, '.*'); // Convert * to .*
		
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(path);
	}

	/**
	 * Validates that operations stay within sandbox
	 */
	private validateSandboxPath(operation: ValidatedOperation): void {
		const sandbox = this.settings.sandboxMode!;
		
		if (operation.path && !operation.path.startsWith(sandbox)) {
			throw new SecurityError(
				`Path must be within sandbox: ${sandbox}`,
				'SANDBOX_VIOLATION'
			);
		}

		if (operation.targetPath && !operation.targetPath.startsWith(sandbox)) {
			throw new SecurityError(
				`Target path must be within sandbox: ${sandbox}`,
				'SANDBOX_VIOLATION'
			);
		}
	}

	/**
	 * Logs security events for auditing
	 */
	private logSecurityEvent(
		operation: VaultOperation,
		result: 'allowed' | 'blocked',
		reason?: string,
		error?: string
	): void {
		if (!this.settings.logSecurityEvents) return;

		const entry: SecurityLogEntry = {
			timestamp: Date.now(),
			operation,
			result,
			reason,
			error
		};

		this.auditLog.push(entry);

		// Keep log size manageable
		if (this.auditLog.length > this.maxLogEntries) {
			this.auditLog.shift();
		}

		// Log to debug console
		if (result === 'blocked') {
			Debug.log(`🚫 Security blocked: ${operation.type} on ${operation.path} - ${reason}`);
		} else if (Debug.isDebugMode()) {
			Debug.log(`✅ Security allowed: ${operation.type} on ${operation.path}`);
		}
	}

	/**
	 * Updates security settings
	 */
	updateSettings(settings: Partial<SecuritySettings>): void {
		this.settings = { ...this.settings, ...settings };
		Debug.log('🔐 Security settings updated', this.settings);
	}

	/**
	 * Gets current security settings
	 */
	getSettings(): SecuritySettings {
		return { 
			...this.settings,
			permissions: { ...this.settings.permissions }
		};
	}

	/**
	 * Gets security audit log
	 */
	getAuditLog(): SecurityLogEntry[] {
		return [...this.auditLog];
	}

	/**
	 * Clears security audit log
	 */
	clearAuditLog(): void {
		this.auditLog = [];
		Debug.log('🧹 Security audit log cleared');
	}

	/**
	 * Quick preset configurations
	 */
	static presets = {
		readOnly: (): Partial<SecuritySettings> => ({
			permissions: {
				read: true,
				create: false,
				update: false,
				delete: false,
				move: false,
				rename: false,
				execute: false
			}
		}),
		
		safeMode: (): Partial<SecuritySettings> => ({
			permissions: {
				read: true,
				create: true,
				update: true,
				delete: false,
				move: true,
				rename: true,
				execute: true
			}
		}),
		
		fullAccess: (): Partial<SecuritySettings> => ({
			permissions: {
				read: true,
				create: true,
				update: true,
				delete: true,
				move: true,
				rename: true,
				execute: true
			}
		})
	};
}