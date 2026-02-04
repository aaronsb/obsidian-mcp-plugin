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

	async listFilesPaginated(directory?: string, page: number = 1, pageSize: number = 20): ReturnType<ObsidianAPI['listFilesPaginated']> {
		const validated = await this.security.validateOperation({
			type: OperationType.READ,
			path: directory || '.',
			context: { method: 'listFilesPaginated', page, pageSize }
		});

		// Use validated path if directory was provided, undefined for vault root
		const listPath = !validated.path || validated.path === '.' ? undefined : validated.path;
		return super.listFilesPaginated(listPath, page, pageSize);
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

	// Note: These methods don't exist in base ObsidianAPI:
	// - trash(), renameFile(), moveFile(), copyFile()
	// They would need to be implemented in the base class first

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