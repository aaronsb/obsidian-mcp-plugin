import { App } from 'obsidian';
import { ObsidianAPI, PatchParams } from '../utils/obsidian-api';
import {
	VaultSecurityManager,
	OperationType,
	SecuritySettings,
	SecurityLogEntry
} from './vault-security-manager';
import { MCPIgnoreManager } from './mcp-ignore-manager';
import { ObsidianConfig, ObsidianFile, ObsidianFileResponse } from '../types/obsidian';
import { BaseYAML } from '../types/bases-yaml';
import { Debug } from '../utils/debug';

/** Minimal plugin interface for security-relevant properties.
 * Includes ObsidianAPIPluginRef fields so the same object can be passed to the base class. */
interface SecurePluginRef {
	settings?: {
		security?: Partial<SecuritySettings>;
		validation?: Partial<import('../validation/input-validator').ValidationConfig>;
		httpPort?: number;
	};
	ignoreManager?: MCPIgnoreManager;
	mcpServer?: { isServerRunning(): boolean; getConnectionCount(): number };
	manifest?: { dir?: string };
}

/**
 * Secure wrapper for ObsidianAPI that enforces path validation and operation permissions
 * This class intercepts all file operations and validates them through the security manager
 */
export class SecureObsidianAPI extends ObsidianAPI {
	private security: VaultSecurityManager;

	constructor(app: App, config?: ObsidianConfig, plugin?: SecurePluginRef, securitySettings?: Partial<SecuritySettings>) {
		super(app, config, plugin);

		// Initialize security manager with provided or default settings
		const settings: Partial<SecuritySettings> = securitySettings || plugin?.settings?.security || {};
		const ignoreManager: MCPIgnoreManager | undefined = plugin?.ignoreManager;
		this.security = new VaultSecurityManager(app, settings, ignoreManager);
		
		Debug.log('🔐 SecureObsidianAPI initialized with security settings:', this.security.getSettings());
		Debug.log('🔐 SecureObsidianAPI has ignoreManager:', !!ignoreManager);
	}

	// File Operations - READ

	async getFile(path: string): Promise<ObsidianFileResponse> {
		const validated = await this.security.validateOperation({
			type: OperationType.READ,
			path: path,
			context: { method: 'getFile' }
		});
		
		return super.getFile(validated.path!);
	}

	async listFiles(directory?: string): Promise<string[]> {
		const validated = await this.security.validateOperation({
			type: OperationType.READ,
			path: directory || '.',
			context: { method: 'listFiles' }
		});

		// Use validated path if directory was provided, undefined for vault root
		const listPath = !validated.path || validated.path === '.' ? undefined : validated.path;
		return super.listFiles(listPath);
	}

	async listFilesPaginated(directory?: string, page: number = 1, pageSize: number = 20, recursive: boolean = false): ReturnType<ObsidianAPI['listFilesPaginated']> {
		const validated = await this.security.validateOperation({
			type: OperationType.READ,
			path: directory || '.',
			context: { method: 'listFilesPaginated', page, pageSize, recursive }
		});

		// Use validated path if directory was provided, undefined for vault root
		const listPath = !validated.path || validated.path === '.' ? undefined : validated.path;
		return super.listFilesPaginated(listPath, page, pageSize, recursive);
	}

	async getActiveFile(): Promise<ObsidianFile> {
		// This doesn't need path validation as it gets the currently active file
		await this.security.validateOperation({
			type: OperationType.READ,
			context: { method: 'getActiveFile' }
		});

		return super.getActiveFile();
	}

	// Note: searchSimple doesn't exist in base ObsidianAPI
	// Use searchPaginated instead

	// File Operations - CREATE

	async createFile(path: string, content: string): ReturnType<ObsidianAPI['createFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.CREATE,
			path: path,
			context: { method: 'createFile', contentSize: content.length }
		});
		
		return super.createFile(validated.path!, content);
	}

	// Note: createFolder doesn't exist in base ObsidianAPI
	// Folders are created automatically when creating files

	// File Operations - UPDATE

	async updateFile(path: string, content: string): ReturnType<ObsidianAPI['updateFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.UPDATE,
			path: path,
			context: { method: 'updateFile', contentSize: content.length }
		});
		
		return super.updateFile(validated.path!, content);
	}

	async appendToFile(path: string, content: string): ReturnType<ObsidianAPI['appendToFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.UPDATE,
			path: path,
			context: { method: 'appendToFile', contentSize: content.length }
		});
		
		return super.appendToFile(validated.path!, content);
	}

	async patchVaultFile(path: string, params: PatchParams): ReturnType<ObsidianAPI['patchVaultFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.UPDATE,
			path: path,
			context: { method: 'patchVaultFile', params }
		});
		
		return super.patchVaultFile(validated.path!, params);
	}

	// File Operations - DELETE

	async deleteFile(path: string): ReturnType<ObsidianAPI['deleteFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.DELETE,
			path: path,
			context: { method: 'deleteFile' }
		});
		
		return super.deleteFile(validated.path!);
	}

	// File Operations - MOVE / RENAME

	/**
	 * Validates BOTH source and destination before a move/rename.
	 *
	 * validateOperation already understands targetPath, so the destination goes
	 * through the same path validator as the source (and the blocked-path check,
	 * which is why .mcpignore protection now covers move destinations too).
	 * Before this override the router called app.fileManager.renameFile directly
	 * and a `../` destination relocated files outside the vault root.
	 *
	 * Charged as RENAME so permissions.rename is real config rather than dead —
	 * moveFile below charges the same Obsidian primitive against permissions.move.
	 */
	async renameFile(path: string, newPath: string): ReturnType<ObsidianAPI['renameFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.RENAME,
			path: path,
			targetPath: newPath,
			context: { method: 'renameFile' }
		});

		return super.renameFile(validated.path!, validated.targetPath!);
	}

	async moveFile(path: string, newPath: string): ReturnType<ObsidianAPI['moveFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.MOVE,
			path: path,
			targetPath: newPath,
			context: { method: 'moveFile' }
		});

		return super.moveFile(validated.path!, validated.targetPath!);
	}

	/**
	 * The command palette contains mutators ("Delete current file", "Move file
	 * to…"), so an unwrapped executeCommand is a write path around the layer.
	 * Latent today — only getCommands() is wired to a tool — but wrapped for the
	 * same reason as the active-file writes above.
	 */
	executeCommand(commandId: string): ReturnType<ObsidianAPI['executeCommand']> {
		this.security.assertOperationPermitted(
			OperationType.EXECUTE,
			{ method: 'executeCommand', commandId }
		);

		return super.executeCommand(commandId);
	}

	// Note: These methods don't exist in base ObsidianAPI:
	// - trash(), copyFile()
	// They would need to be implemented in the base class first

	// Bases

	/**
	 * Routes base creation through the security layer.
	 *
	 * createBase writes with app.vault.create() and was the one write in the
	 * plugin that reached the vault without passing through here, so neither the
	 * read-only permission check nor path validation applied. A `../` path
	 * created files outside the vault root.
	 */
	async createBase(path: string, config: BaseYAML): Promise<void> {
		const validated = await this.security.validateOperation({
			type: OperationType.CREATE,
			path: path,
			context: { method: 'createBase' }
		});

		return super.createBase(validated.path!, config);
	}

	// Active-file writes
	//
	// Not currently reachable from the tool surface, but they write via
	// app.vault.modify / fileManager.trashFile, so an unwrapped version is the
	// same bug class as createBase waiting for its first caller. patchActiveFile
	// needs no override — it delegates to the wrapped patchVaultFile.

	async updateActiveFile(content: string): ReturnType<ObsidianAPI['updateActiveFile']> {
		await this.security.validateOperation({
			type: OperationType.UPDATE,
			context: { method: 'updateActiveFile', contentSize: content.length }
		});

		return super.updateActiveFile(content);
	}

	async appendToActiveFile(content: string): ReturnType<ObsidianAPI['appendToActiveFile']> {
		await this.security.validateOperation({
			type: OperationType.UPDATE,
			context: { method: 'appendToActiveFile', contentSize: content.length }
		});

		return super.appendToActiveFile(content);
	}

	async deleteActiveFile(): ReturnType<ObsidianAPI['deleteActiveFile']> {
		await this.security.validateOperation({
			type: OperationType.DELETE,
			context: { method: 'deleteActiveFile' }
		});

		return super.deleteActiveFile();
	}

	// File Operations - EXECUTE

	async openFile(path: string): ReturnType<ObsidianAPI['openFile']> {
		const validated = await this.security.validateOperation({
			type: OperationType.EXECUTE,
			path: path,
			context: { method: 'openFile' }
		});
		
		return super.openFile(validated.path!);
	}

	// Note: These methods don't exist in base ObsidianAPI:
	// - combineMergeFiles(), splitFile()
	// They would need to be implemented in the base class first

	// Security Management Methods

	/**
	 * Updates security settings
	 */
	updateSecuritySettings(settings: Partial<SecuritySettings>): void {
		this.security.updateSettings(settings);
		Debug.log('🔐 Security settings updated');
	}

	/**
	 * Gets current security settings
	 */
	getSecuritySettings(): SecuritySettings {
		return this.security.getSettings();
	}

	/**
	 * Gets security audit log
	 */
	getSecurityAuditLog(): SecurityLogEntry[] {
		return this.security.getAuditLog();
	}

	/**
	 * Clears security audit log
	 */
	clearSecurityAuditLog(): void {
		this.security.clearAuditLog();
	}

	/**
	 * Apply security preset
	 */
	applySecurityPreset(preset: 'readOnly' | 'safeMode' | 'fullAccess'): void {
		const presetSettings = VaultSecurityManager.presets[preset]();
		this.security.updateSettings(presetSettings);
		Debug.log(`🔐 Applied security preset: ${preset}`);
	}
}