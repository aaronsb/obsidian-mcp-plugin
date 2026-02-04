import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, setIcon, Modal, TextComponent, ButtonComponent, FileSystemAdapter } from 'obsidian';
import { MCPHttpServer } from './mcp-server';
import { getVersion } from './version';
import { Debug } from './utils/debug';
import { MCPIgnoreManager } from './security/mcp-ignore-manager';
import { randomBytes } from 'crypto';
import { PluginDetector } from './utils/plugin-detector';
import { CertificateConfig } from './utils/certificate-manager';
import { ValidationConfig } from './validation/input-validator';

interface MCPServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	transport?: {
		type: string;
		url: string;
	};
}

interface MCPClientConfig {
	mcpServers: Record<string, MCPServerEntry>;
}

interface MCPPluginSettings {
	httpEnabled: boolean;
	httpPort: number;
	httpsEnabled: boolean;
	httpsPort: number;
	certificateConfig: CertificateConfig;
	debugLogging: boolean;
	showConnectionStatus: boolean;
	autoDetectPortConflicts: boolean;
	enableConcurrentSessions: boolean;
	maxConcurrentConnections: number;
	apiKey: string;
	dangerouslyDisableAuth: boolean;
	readOnlyMode: boolean;
	pathExclusionsEnabled: boolean;
	enableIgnoreContextMenu: boolean;
	validation?: Partial<ValidationConfig>;
}

interface MCPServerInfo {
	version: string;
	running: boolean;
	port: number;
	vaultName: string;
	vaultPath: string;
	toolsCount: number;
	resourcesCount: number;
	connections: number;
	concurrentSessions: boolean;
	poolStats: {
		enabled: boolean;
		stats?: {
			activeConnections: number;
			maxConnections: number;
			utilization: number;
			queuedRequests: number;
		};
	} | undefined;
}

const DEFAULT_SETTINGS: MCPPluginSettings = {
	httpEnabled: true, // Start enabled by default
	httpPort: 3001,
	httpsEnabled: false, // HTTPS disabled by default
	httpsPort: 3443,
	certificateConfig: {
		enabled: false,
		selfSigned: true,
		autoGenerate: true,
		rejectUnauthorized: false,
		minTLSVersion: 'TLSv1.2'
	},
	debugLogging: false,
	showConnectionStatus: true,
	autoDetectPortConflicts: true,
	enableConcurrentSessions: false, // Disabled by default for backward compatibility
	maxConcurrentConnections: 32,
	apiKey: '', // Will be generated on first load
	dangerouslyDisableAuth: false, // Auth enabled by default
	readOnlyMode: false, // Read-only mode disabled by default
	pathExclusionsEnabled: false, // Path exclusions disabled by default
	enableIgnoreContextMenu: false, // Context menu disabled by default
	validation: {
		maxFileSize: 10 * 1024 * 1024, // 10MB default
		maxBatchSize: 100,
		maxPathLength: 255,
		maxRegexComplexity: 100,
		strictMode: false
	}
};

export default class ObsidianMCPPlugin extends Plugin {
	settings!: MCPPluginSettings;
	mcpServer?: MCPHttpServer;
	ignoreManager?: MCPIgnoreManager;
	private currentVaultName: string = '';
	private currentVaultPath: string = '';
	private vaultSwitchTimeout?: number;
	private statsUpdateInterval?: number;

	async onload() {
		Debug.log(`🚀 Starting Semantic Notes Vault MCP v${getVersion()}`);
		
		try {
			await this.loadSettings();
			Debug.setDebugMode(this.settings.debugLogging);
			Debug.log('✅ Settings loaded');
			
			// Debug log read-only mode status at startup
			if (this.settings.readOnlyMode) {
				Debug.log('🔒 READ-ONLY MODE detected in settings - will activate on server start');
			} else {
				Debug.log('✅ READ-ONLY MODE not enabled - normal operations mode');
			}

			// Initialize ignore manager
			this.ignoreManager = new MCPIgnoreManager(this.app);
			this.ignoreManager.setEnabled(this.settings.pathExclusionsEnabled);
			if (this.settings.pathExclusionsEnabled) {
				await this.ignoreManager.loadIgnoreFile();
				Debug.log('✅ Path exclusions initialized');
			} else {
				Debug.log('✅ Path exclusions disabled');
			}

			// Initialize vault context tracking
			this.initializeVaultContext();

			// Add settings tab
			this.addSettingTab(new MCPSettingTab(this.app, this));
			Debug.log('✅ Settings tab added');

			// Add command
			this.addCommand({
				id: 'restart-mcp-server',
				name: 'Restart mcp server',
				callback: async () => {
					Debug.log('🔄 MCP Server restart requested');
					await this.stopMCPServer();
					if (this.settings.httpEnabled || this.settings.httpsEnabled) {
						await this.startMCPServer();
					}
				}
			});
			Debug.log('✅ Command added');

			// Setup vault monitoring
			this.setupVaultMonitoring();

			// Register context menu for path exclusions
			if (this.settings.pathExclusionsEnabled && this.settings.enableIgnoreContextMenu) {
				this.registerContextMenu();
			}

			// Start MCP server if either HTTP or HTTPS is enabled
			if (this.settings.httpEnabled || this.settings.httpsEnabled) {
				await this.startMCPServer();
			} else {
				Debug.log('⚠️ Both HTTP and HTTPS servers are disabled in settings');
			}

			// Add status bar item
			this.updateStatusBar();
			Debug.log('✅ Status bar added');

			// Start stats update interval
			this.startStatsUpdates();

			Debug.log('🎉 Obsidian MCP Plugin loaded successfully');
		} catch (error) {
			Debug.error('❌ Error loading Obsidian MCP Plugin:', error);
			throw error; // Re-throw to show in Obsidian's plugin list
		}
	}

	onunload() {
		Debug.log('👋 Unloading Obsidian MCP Plugin');

		// Clear vault monitoring
		if (this.vaultSwitchTimeout) {
			window.clearTimeout(this.vaultSwitchTimeout);
		}

		// Clear stats updates
		if (this.statsUpdateInterval) {
			window.clearInterval(this.statsUpdateInterval);
		}

		void this.stopMCPServer();
	}

	async startMCPServer(): Promise<void> {
		try {
			// Determine which port to check based on whether HTTPS is enabled
			const isHttps = this.settings.httpsEnabled && this.settings.certificateConfig?.enabled;
			const portToUse = isHttps ? this.settings.httpsPort : this.settings.httpPort;
			const protocol = isHttps ? 'HTTPS' : 'HTTP';
			
			// Check for port conflicts and auto-switch if needed
			if (this.settings.autoDetectPortConflicts) {
				const status = await this.checkPortConflict(portToUse);
				if (status === 'in-use') {
					const suggestedPort = await this.findAvailablePort(portToUse);
					
					if (suggestedPort === 0) {
						// All alternate ports are busy
						const portsChecked = `${portToUse}, ${portToUse + 1}, ${portToUse + 2}, ${portToUse + 3}`;
						Debug.error(`❌ Failed to find available port after 3 attempts. Ports checked: ${portsChecked}`);
						Debug.error('Please check for other applications using these ports or firewall/security software blocking access.');
						new Notice(`Cannot start MCP server: Ports ${portToUse}-${portToUse + 3} are all in use. Check console for details.`);
						this.updateStatusBar();
						return;
					}
					
					Debug.log(`⚠️ ${protocol} Port ${portToUse} is in use, switching to port ${suggestedPort}`);
					new Notice(`${protocol} Port ${portToUse} is in use. Switching to port ${suggestedPort}`);
					
					// Temporarily use the suggested port for this session
					this.mcpServer = new MCPHttpServer(this.app, suggestedPort, this);
					await this.mcpServer.start();
					this.updateStatusBar();
					Debug.log(`✅ MCP server started on alternate ${protocol} port ${suggestedPort}`);
					if (this.settings.showConnectionStatus) {
						new Notice(`MCP server started on ${protocol} port ${suggestedPort} (default port was in use)`);
					}
					return;
				}
			}

			Debug.log(`🚀 Starting MCP server on ${protocol} port ${portToUse}...`);
			this.mcpServer = new MCPHttpServer(this.app, portToUse, this);
			await this.mcpServer.start();
			this.updateStatusBar();
			Debug.log('✅ MCP server started successfully');
			if (this.settings.showConnectionStatus) {
				new Notice(`MCP server started on ${protocol} port ${portToUse}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Debug.error('❌ Failed to start MCP server:', error);
			new Notice(`Failed to start MCP server: ${message}`);
			this.updateStatusBar();
		}
	}

	async stopMCPServer(): Promise<void> {
		if (this.mcpServer) {
			Debug.log('🛑 Stopping MCP server...');
			await this.mcpServer.stop();
			this.mcpServer = undefined;
			this.updateStatusBar();
			Debug.log('✅ MCP server stopped');
		}
	}

	private statusBarItem?: HTMLElement;

	updateStatusBar(): void {
		if (this.statusBarItem) {
			this.statusBarItem.remove();
		}
		
		if (!this.settings.showConnectionStatus) {
			return;
		}

		this.statusBarItem = this.addStatusBarItem();

		// Remove any existing status classes
		this.statusBarItem.removeClass('mcp-statusbar-disabled', 'mcp-statusbar-running', 'mcp-statusbar-error');

		if (!this.settings.httpEnabled && !this.settings.httpsEnabled) {
			this.statusBarItem.setText('Mcp: disabled');
			this.statusBarItem.addClass('mcp-statusbar-disabled');
		} else if (this.mcpServer?.isServerRunning()) {
			const vaultName = this.app.vault.getName();
			const protocols: string[] = [];
			if (this.settings.httpEnabled) protocols.push(`HTTP:${this.settings.httpPort}`);
			if (this.settings.httpsEnabled) protocols.push(`HTTPS:${this.settings.httpsPort}`);
			this.statusBarItem.setText(`MCP: ${vaultName} (${protocols.join(', ')})`);
			this.statusBarItem.addClass('mcp-statusbar-running');
		} else {
			this.statusBarItem.setText('Mcp: error');
			this.statusBarItem.addClass('mcp-statusbar-error');
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MCPPluginSettings>);
		
		// Generate API key on first load if not present
		if (!this.settings.apiKey) {
			this.settings.apiKey = this.generateApiKey();
			await this.saveSettings();
			Debug.log('🔐 Generated new API key for authentication');
		}
	}
	
	public generateApiKey(): string {
		// Generate a secure random API key
		const bytes = randomBytes(32);
		return bytes.toString('base64url');
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async checkPortConflict(port: number): Promise<'available' | 'this-server' | 'in-use'> {
		try {
			// Check if this is our own server
			if (this.mcpServer?.isServerRunning() && this.settings.httpPort === port) {
				return 'this-server';
			}

			// Try to create a temporary server to test port availability
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const http = require('http') as typeof import('http');
			const testServer = http.createServer();
			return new Promise((resolve) => {
				testServer.listen(port, '127.0.0.1', () => {
					testServer.close(() => resolve('available')); // Port is available
				});
				testServer.on('error', () => resolve('in-use')); // Port is in use
			});
		} catch {
			return 'available'; // Assume available if we can't test
		}
	}

	private async findAvailablePort(startPort: number): Promise<number> {
		const maxRetries = 3;
		for (let i = 1; i <= maxRetries; i++) {
			const port = startPort + i;
			const status = await this.checkPortConflict(port);
			if (status === 'available') {
				return port;
			}
			Debug.log(`Port ${port} is also in use, trying next...`);
		}
		// If all 3 alternate ports are busy, return 0 to indicate failure
		return 0;
	}

	getMCPServerInfo(): MCPServerInfo {
		const poolStats = this.mcpServer?.getConnectionPoolStats();
		const resourceCount = this.settings.enableConcurrentSessions ? 2 : 1; // vault-info + session-info
		
		return {
			version: getVersion(),
			running: this.mcpServer?.isServerRunning() || false,
			port: this.settings.httpPort,
			vaultName: this.app.vault.getName(),
			vaultPath: this.getVaultPath(),
			toolsCount: 6, // Our 6 semantic tools (including graph)
			resourcesCount: resourceCount,
			connections: this.mcpServer?.getConnectionCount() || 0,
			concurrentSessions: this.settings.enableConcurrentSessions,
			poolStats: poolStats
		};
	}

	private startStatsUpdates(): void {
		// Update stats every 3 seconds
		this.statsUpdateInterval = window.setInterval(() => {
			// Update status bar with latest info
			this.updateStatusBar();
			
			// Update live stats in settings panel if it's open
			const appWithSetting = this.app as unknown as { setting?: { activeTab?: PluginSettingTab } };
			const settingsTab = appWithSetting.setting?.activeTab;
			if (settingsTab && settingsTab instanceof MCPSettingTab) {
				settingsTab.updateLiveStats();
			}
		}, 3000);
	}

	private initializeVaultContext(): void {
		this.currentVaultName = this.app.vault.getName();
		this.currentVaultPath = this.getVaultPath();
		Debug.log(`📁 Initial vault context: ${this.currentVaultName} at ${this.currentVaultPath}`);
	}

	private getVaultPath(): string {
		try {
			// Try to get the vault path from the adapter
			const adapter = this.app.vault.adapter;
			if (adapter instanceof FileSystemAdapter) {
				return adapter.getBasePath();
			}
			return '';
		} catch {
			return '';
		}
	}

	public registerContextMenu(): void {
		// Register file menu
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!this.ignoreManager || !this.settings.pathExclusionsEnabled || !this.settings.enableIgnoreContextMenu) {
					return;
				}

				menu.addItem((item) => {
					item
						.setTitle('Add to .mcpignore')
						.setIcon('x-circle')
						.onClick(async () => {
							try {
								// Ensure .mcpignore exists
								const exists = await this.ignoreManager!.ignoreFileExists();
								if (!exists) {
									await this.ignoreManager!.createDefaultIgnoreFile();
								}

								// Get relative path from vault root
								const relativePath = file.path;
								let pattern = relativePath;

								// If it's a folder, add trailing slash
								if (file instanceof TFolder) {
									pattern = relativePath + '/';
								}

								// Read current content or use empty string if file doesn't exist
								let currentContent = '';
								try {
									currentContent = await this.app.vault.adapter.read('.mcpignore');
								} catch {
									Debug.log('.mcpignore not found when reading, will create new');
									currentContent = '';
								}
								
								// Append new pattern
								const newContent = currentContent.trimEnd() + '\n' + pattern + '\n';
								await this.app.vault.adapter.write('.mcpignore', newContent);

								// Reload patterns
								await this.ignoreManager!.forceReload();

								new Notice(`✅ Added "${pattern}" to .mcpignore`);
								Debug.log(`Added pattern to .mcpignore: ${pattern}`);
							} catch (error: unknown) {
								Debug.log('Failed to add to .mcpignore:', error);
								const errorMsg = error instanceof Error ? error.message : 'Unknown error';
								new Notice(`❌ Failed to add to .mcpignore: ${errorMsg}`);
							}
						});
				});
			})
		);
	}

	private setupVaultMonitoring(): void {
		// Monitor layout changes which might indicate vault context changes
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.checkVaultContext();
			})
		);

		// Monitor file operations that can help detect vault changes
		this.registerEvent(
			this.app.vault.on('create', () => {
				this.checkVaultContext();
			})
		);

		// Also monitor on active leaf changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.checkVaultContext();
			})
		);

		// Periodic check as fallback (every 30 seconds)
		this.registerInterval(
			window.setInterval(() => {
				this.checkVaultContext();
			}, 30000)
		);
	}

	private checkVaultContext(): void {
		const newVaultName = this.app.vault.getName();
		const newVaultPath = this.getVaultPath();

		// Check if vault has changed (name or path)
		if (newVaultName !== this.currentVaultName ||
			(newVaultPath && newVaultPath !== this.currentVaultPath)) {

			void this.handleVaultSwitch(
				this.currentVaultName,
				newVaultName,
				this.currentVaultPath,
				newVaultPath
			);
		}
	}

	private async handleVaultSwitch(
		oldVaultName: string, 
		newVaultName: string, 
		oldVaultPath: string, 
		newVaultPath: string
	): Promise<void> {
		Debug.log(`🔄 Vault switch detected: ${oldVaultName} → ${newVaultName}`);
		Debug.log(`📁 Path change: ${oldVaultPath} → ${newVaultPath}`);

		// Update current context
		this.currentVaultName = newVaultName;
		this.currentVaultPath = newVaultPath;

		// Show notification if enabled
		if (this.settings.showConnectionStatus) {
			new Notice(`MCP Plugin: Switched to vault "${newVaultName}"`);
		}

		// Restart MCP server to use new vault context
		if ((this.settings.httpEnabled || this.settings.httpsEnabled) && this.mcpServer?.isServerRunning()) {
			Debug.log('🔄 Restarting MCP server for new vault context...');
			
			// Use a small delay to avoid rapid restarts
			if (this.vaultSwitchTimeout) {
				window.clearTimeout(this.vaultSwitchTimeout);
			}
			
			this.vaultSwitchTimeout = window.setTimeout(() => {
				void (async () => {
					await this.stopMCPServer();
					await this.startMCPServer();
					Debug.log(`✅ MCP server restarted for vault: ${newVaultName}`);
				})();
			}, 1000); // 1 second delay
		}

		// Update status bar to reflect new vault
		this.updateStatusBar();
	}
}

class MCPSettingTab extends PluginSettingTab {
	plugin: ObsidianMCPPlugin;
	private easterEggClicks = 0;
	private easterEggTimeout?: number;

	constructor(app: App, plugin: ObsidianMCPPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		;

		// Connection Status Section
		this.createConnectionStatusSection(containerEl);
		
		// Server Configuration Section
		this.createServerConfigSection(containerEl);
		
		// HTTPS Configuration Section
		this.createHTTPSConfigSection(containerEl);
		
		// Authentication Section
		this.createAuthenticationSection(containerEl);
		
		// Security Section
		this.createSecuritySection(containerEl);
		
		// UI Options Section
		this.createUIOptionsSection(containerEl);
		
		// Protocol Information Section (always show)
		this.createProtocolInfoSection(containerEl);
	}

	private createConnectionStatusSection(containerEl: HTMLElement): void {
		const statusEl = containerEl.createDiv('mcp-status-section');
		new Setting(statusEl).setName("Connection status").setHeading();
		
		const info = this.plugin.getMCPServerInfo();
		if (info) {
			const statusGrid = statusEl.createDiv('mcp-status-grid');
			
			const createStatusItem = (label: string, value: string, colorClass?: string) => {
				const item = statusGrid.createDiv();
				item.createEl('strong', {text: `${label}: `});
				const valueEl = item.createSpan({text: value});
				if (colorClass) valueEl.classList.add('mcp-status-value', colorClass);
			};
			
			createStatusItem('Status', info.running ? 'Running' : 'Stopped', 
				info.running ? 'success' : 'error');
			createStatusItem('Port', info.port.toString());
			createStatusItem('Vault', info.vaultName);
			if (info.vaultPath) {
				createStatusItem('Path', info.vaultPath.length > 50 ? '...' + info.vaultPath.slice(-47) : info.vaultPath);
			}
			// Version with easter egg trigger
			const versionItem = statusGrid.createDiv();
			versionItem.createEl('strong', {text: 'Version: '});
			const versionEl = versionItem.createSpan({text: info.version, cls: 'mcp-version-easter-egg'});
			versionEl.addEventListener('click', () => this.handleEasterEggClick());
			createStatusItem('Tools', info.toolsCount.toString());
			createStatusItem('Resources', info.resourcesCount.toString());
			createStatusItem('Connections', info.connections.toString());
			
			// Show pool stats if concurrent sessions are enabled
			if (info.concurrentSessions && info.poolStats?.enabled && info.poolStats.stats) {
				const poolStats = info.poolStats.stats;
				createStatusItem('Active Sessions', `${poolStats.activeConnections}/${poolStats.maxConnections}`);
				createStatusItem('Pool Utilization', `${Math.round(poolStats.utilization * 100)}%`, 
					poolStats.utilization > 0.8 ? 'warning' : 'success');
				if (poolStats.queuedRequests > 0) {
					createStatusItem('Queued Requests', poolStats.queuedRequests.toString(), 'warning');
				}
			}
		} else {
			statusEl.createDiv({text: 'Server not running', cls: 'mcp-status-offline'});
		}
	}

	private createServerConfigSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Server configuration").setHeading();

		new Setting(containerEl)
			.setName('Enable HTTP server')
			.setDesc('Enable HTTP server on port ' + this.plugin.settings.httpPort + (this.plugin.settings.httpsEnabled ? ' (can be disabled when HTTPS is enabled)' : ' (required - at least one protocol must be enabled)'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.httpEnabled)
				.setDisabled(!this.plugin.settings.httpsEnabled) // Can only disable HTTP if HTTPS is enabled
				.onChange(async (value) => {
					// Prevent disabling both protocols
					if (!value && !this.plugin.settings.httpsEnabled) {
						new Notice('Cannot disable HTTP when HTTPS is disabled. Enable HTTPS first.');
						toggle.setValue(true);
						return;
					}
					
					this.plugin.settings.httpEnabled = value;
					await this.plugin.saveSettings();
					
					// Restart server with new settings
					if (this.plugin.mcpServer?.isServerRunning()) {
						await this.plugin.stopMCPServer();
						await this.plugin.startMCPServer();
					} else if (value) {
						await this.plugin.startMCPServer();
					}
					
					// Update the status display
					this.display();
				}));

		const portSetting = new Setting(containerEl)
			.setName('Server port')
			.setDesc('Port for the server (default: 3001)')
			.addText(text => {
				let pendingPort = this.plugin.settings.httpPort;
				let hasChanges = false;
				
				text.setPlaceholder('3001')
					.setValue(this.plugin.settings.httpPort.toString())
					.onChange((value) => {
						const port = parseInt(value);
						if (!isNaN(port) && port > 0 && port < 65536) {
							pendingPort = port;
							hasChanges = (port !== this.plugin.settings.httpPort);

							// Update button visibility and port validation
							this.updatePortApplyButton(portSetting, hasChanges, pendingPort);
							void this.checkPortAvailability(port, portSetting);
						} else {
							hasChanges = false;
							this.updatePortApplyButton(portSetting, false, pendingPort);
						}
					});
				
				return text;
			})
			.addButton(button => {
				button.setButtonText('Apply')
					.setClass('mod-cta')
					.onClick(async () => {
						const textComponent = portSetting.components.find((c): c is TextComponent => c instanceof TextComponent);
						const newPort = parseInt(textComponent?.inputEl.value ?? '');
						
						if (!isNaN(newPort) && newPort > 0 && newPort < 65536) {
							const oldPort = this.plugin.settings.httpPort;
							this.plugin.settings.httpPort = newPort;
							await this.plugin.saveSettings();
							
							// Auto-restart server if port changed and server is running
							if (oldPort !== newPort && this.plugin.mcpServer?.isServerRunning()) {
								new Notice(`Restarting MCP server on port ${newPort}...`);
								await this.plugin.stopMCPServer();
								await this.plugin.startMCPServer();
								setTimeout(() => this.refreshConnectionStatus(), 500);
							}
							
							// Hide apply button
							button.buttonEl.classList.add('mcp-hidden');
							portSetting.setDesc('Port for HTTP mcp server (default: 3001)');
						}
					});
				
				// Initially hide the apply button
				button.buttonEl.classList.add('mcp-hidden');
				return button;
			});
		
		// Don't check port availability on load - only when changed or server starts
		// This avoids detecting our own running server as a conflict

		new Setting(containerEl)
			.setName('Auto-detect port conflicts')
			.setDesc('Automatically detect and warn about port conflicts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoDetectPortConflicts)
				.onChange(async (value) => {
					this.plugin.settings.autoDetectPortConflicts = value;
					await this.plugin.saveSettings();
				}));
	}
	
	private createHTTPSConfigSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Secure transport").setHeading();
		
		new Setting(containerEl)
			.setName('Enable HTTPS server')
			.setDesc('Enable HTTPS server on port ' + this.plugin.settings.httpsPort + (this.plugin.settings.httpEnabled ? ' (optional when HTTP is enabled)' : ' (required - cannot be disabled when HTTP is disabled)'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.httpsEnabled)
				.setDisabled(!this.plugin.settings.httpEnabled && this.plugin.settings.httpsEnabled) // Can't disable HTTPS if HTTP is disabled
				.onChange(async (value) => {
					// Prevent disabling both protocols
					if (!value && !this.plugin.settings.httpEnabled) {
						new Notice('Cannot disable HTTPS when HTTP is disabled. Enable HTTP first.');
						toggle.setValue(true);
						return;
					}
					
					this.plugin.settings.httpsEnabled = value;
					this.plugin.settings.certificateConfig.enabled = value;
					await this.plugin.saveSettings();
					
					// Show/hide HTTPS settings and update HTTP toggle state
					this.display();
					
					// Restart server if running
					if (this.plugin.mcpServer?.isServerRunning()) {
						new Notice('Restarting server with new protocol settings...');
						await this.plugin.stopMCPServer();
						await this.plugin.startMCPServer();
					} else if (value && (this.plugin.settings.httpEnabled || this.plugin.settings.httpsEnabled)) {
						await this.plugin.startMCPServer();
					}
				}));
		
		if (this.plugin.settings.httpsEnabled) {
			const httpsPortSetting = new Setting(containerEl)
				.setName('Secure port')
				.setDesc('Port for secure connections (default: 3443)')
				.addText(text => text
					.setPlaceholder('3443')
					.setValue(this.plugin.settings.httpsPort.toString())
					.onChange((value) => {
						const port = parseInt(value);
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.httpsPort = port;
							void this.plugin.saveSettings();
							// Check port availability for HTTPS
							void this.checkHttpsPortAvailability(port, httpsPortSetting);
						}
					}));
			
			// Don't check HTTPS port availability on load - only when changed or server starts
			// This avoids detecting our own running server as a conflict
			
			new Setting(containerEl)
				.setName('Auto-generate certificate')
				.setDesc(this.plugin.settings.certificateConfig.autoGenerate === false ? 
					'📝 Note: Custom certificates should have a valid CA signing chain for seamless client connections' :
					'Automatically generate a self-signed certificate if none exists')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.certificateConfig.autoGenerate || false)
					.onChange(async (value) => {
						this.plugin.settings.certificateConfig.autoGenerate = value;
						await this.plugin.saveSettings();
						// Refresh the display to update the description
						this.display();
					}));
			
			new Setting(containerEl)
				.setName('Certificate path')
				.setDesc('Path to custom certificate file (.crt) - leave empty for auto-generated')
				.addText(text => text
					.setPlaceholder('Leave empty for auto-generated')
					.setValue(this.plugin.settings.certificateConfig.certPath || '')
					.onChange(async (value) => {
						this.plugin.settings.certificateConfig.certPath = value || undefined;
						await this.plugin.saveSettings();
						// Refresh display to update configuration examples
						this.display();
					}));
			
			new Setting(containerEl)
				.setName('Key path')
				.setDesc('Path to private key file (.key) - leave empty for auto-generated')
				.addText(text => text
					.setPlaceholder('Leave empty for auto-generated')
					.setValue(this.plugin.settings.certificateConfig.keyPath || '')
					.onChange(async (value) => {
						this.plugin.settings.certificateConfig.keyPath = value || undefined;
						await this.plugin.saveSettings();
					}));
			
			new Setting(containerEl)
				.setName('Minimum TLS version')
				.setDesc('Minimum TLS version to accept')
				.addDropdown(dropdown => dropdown
					.addOption('TLSv1.2', 'TLS 1.2')
					.addOption('TLSv1.3', 'TLS 1.3')
					.setValue(this.plugin.settings.certificateConfig.minTLSVersion || 'TLSv1.2')
					.onChange(async (value) => {
						this.plugin.settings.certificateConfig.minTLSVersion = value as 'TLSv1.2' | 'TLSv1.3';
						await this.plugin.saveSettings();
					}));
			
			// Certificate status
			const statusEl = containerEl.createDiv('mcp-cert-status');
			new Setting(statusEl).setName("Certificate status").setHeading();

			// Check certificate status asynchronously
			void import('./utils/certificate-manager').then(module => {
				const certManager = new module.CertificateManager(this.app);
			if (certManager.hasDefaultCertificate()) {
				const paths = certManager.getDefaultPaths();
				const loaded = certManager.loadCertificate(paths.certPath, paths.keyPath);
				if (loaded) {
					const info = certManager.getCertificateInfo(loaded.cert);
					if (info) {
						statusEl.createEl('p', {
							text: `✅ Certificate valid until: ${info.validTo.toLocaleDateString()}`,
							cls: 'setting-item-description mcp-security-note'
						});
						if (info.daysUntilExpiry < 30) {
							statusEl.createEl('p', {
								text: `⚠️ Certificate expires in ${info.daysUntilExpiry} days`,
								cls: 'setting-item-description mod-warning'
							});
						}
					}
				}
			} else {
				statusEl.createEl('p', {
					text: '📝 no certificate found - will auto-generate on server start',
					cls: 'setting-item-description mcp-security-note'
				});
			}
			});
		}
	}
	
	private createAuthenticationSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Authentication").setHeading();
		
		new Setting(containerEl)
			.setName('Authentication key')
			.setDesc('Secure key for authenticating mcp clients')
			.addText(text => {
				const input = text
					.setPlaceholder('API key will be shown here')
					.setValue(this.plugin.settings.apiKey)
					.setDisabled(true);
				
				// Add classes for styling
				input.inputEl.classList.add('mcp-api-key-input', 'mcp-monospace-input');
				
				return input;
			})
			.addButton(button => button
				.setButtonText('Copy')
				.setTooltip('Copy API key to clipboard')
				.onClick(async () => {
					await navigator.clipboard.writeText(this.plugin.settings.apiKey);
					new Notice('API key copied to clipboard');
				}))
			.addButton(button => button
				.setButtonText('Regenerate')
				.setTooltip('Generate a new API key')
				.setWarning()
				.onClick(() => {
					new ConfirmationModal(
						this.app,
						'Are you sure you want to regenerate the API key? This will invalidate the current key and require updating all MCP clients.',
						async () => {
							this.plugin.settings.apiKey = this.plugin.generateApiKey();
							await this.plugin.saveSettings();
							new Notice('API key regenerated. Update your mcp clients with the new key.');
							this.display();
						}
					).open();
				}));
		
		// Add a note about security
		containerEl.createEl('p', {
			text: 'Note: the API key is stored in the plugin settings file. Anyone with access to your vault can read it.',
			cls: 'setting-item-description mcp-security-note'
		});
		
		// Add note about auth methods
		containerEl.createEl('p', {
			text: 'Supports both bearer token (recommended) and basic authentication.',
			cls: 'setting-item-description mcp-security-note'
		});
		
		// Add dangerous disable auth toggle
		new Setting(containerEl)
			.setName('Disable authentication')
			.setDesc('⚠️ dangerous: disable authentication entirely. Only use for testing or if you fully trust your local environment.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dangerouslyDisableAuth)
				.onChange(async (value) => {
					this.plugin.settings.dangerouslyDisableAuth = value;
					await this.plugin.saveSettings();
					
					// Show warning if disabling auth
					if (value) {
						new Notice('⚠️ authentication disabled! Your vault is accessible without credentials.');
					} else {
						new Notice('✅ authentication enabled. API key required for access.');
					}
					
					// Refresh display to update examples
					this.display();
				}));
	}

	private createSecuritySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Security").setHeading();
		
		new Setting(containerEl)
			.setName('Read-Only mode')
			.setDesc('Enable read-only mode - blocks all write operations (create, update, delete, move, rename)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.readOnlyMode)
				.onChange(async (value) => {
					this.plugin.settings.readOnlyMode = value;
					await this.plugin.saveSettings();
					
					// Debug logging for read-only mode changes
					if (value) {
						Debug.log('🔒 READ-ONLY MODE ENABLED via settings - Server restart required for activation');
						new Notice('🔒 read-only mode enabled. All write operations are blocked.');
					} else {
						Debug.log('✅ READ-ONLY MODE DISABLED via settings - Server restart required for deactivation');
						new Notice('✅ read-only mode disabled. All operations are allowed.');
					}
					
					// Refresh display to update examples
					this.display();
				}));

		// Path Exclusions Setting
		new Setting(containerEl)
			.setName('Path exclusions')
			.setDesc('Exclude files and directories from mcp operations using .gitignore-style patterns')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pathExclusionsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.pathExclusionsEnabled = value;
					await this.plugin.saveSettings();
					
					if (this.plugin.ignoreManager) {
						this.plugin.ignoreManager.setEnabled(value);
						if (value) {
							await this.plugin.ignoreManager.loadIgnoreFile();
							Debug.log('✅ Path exclusions enabled');
							new Notice('✅ path exclusions enabled');
						} else {
							Debug.log('🔓 Path exclusions disabled');
							new Notice('🔓 path exclusions disabled');
						}
					}
					
					// Refresh display to show/hide file management options
					this.display();
				}));

		// Show context menu toggle if path exclusions are enabled
		if (this.plugin.settings.pathExclusionsEnabled) {
			new Setting(containerEl)
				.setName('Enable right-click context menu')
				.setDesc('Add "add to .mcpignore" option to file/folder context menus')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enableIgnoreContextMenu)
					.onChange(async (value) => {
						this.plugin.settings.enableIgnoreContextMenu = value;
						await this.plugin.saveSettings();
						
						if (value) {
							this.plugin.registerContextMenu();
							new Notice('✅ context menu enabled - restart required for full effect');
						} else {
							new Notice('🔓 context menu disabled - restart required for full effect');
						}
					}));
		}

		// Show file management options if path exclusions are enabled
		if (this.plugin.settings.pathExclusionsEnabled) {
			this.createPathExclusionManagement(containerEl);
		}
	}

	private createPathExclusionManagement(containerEl: HTMLElement): void {
		Debug.log('Creating path exclusion management UI');
		const exclusionSection = containerEl.createDiv('mcp-exclusion-section');
		new Setting(exclusionSection).setName(".mcpignore file management").setHeading();

		if (this.plugin.ignoreManager) {
			Debug.log('Ignore manager available, creating buttons');
			const stats = this.plugin.ignoreManager.getStats();
			
			// Status info
			const statusEl = exclusionSection.createDiv('mcp-exclusion-status');
			statusEl.createEl('p', {
				text: `Current exclusions: ${stats.patternCount} patterns active`,
				cls: 'setting-item-description mcp-security-note'
			});
			
			// Helper text
			statusEl.createEl('p', {
				text: 'Save patterns in .mcpignore file before reloading',
				cls: 'setting-item-description mcp-security-note'
			});
			
			if (stats.lastModified > 0) {
				statusEl.createEl('p', {
					text: `Last modified: ${new Date(stats.lastModified).toLocaleString()}`,
					cls: 'setting-item-description mcp-security-note'
				});
			}

			// File management buttons
			const buttonContainer = exclusionSection.createDiv('mcp-exclusion-buttons');
			
			// Open in default app button
			const openButton = buttonContainer.createEl('button', {
				text: 'Open in default app',
				cls: 'mod-cta'
			});
			openButton.addEventListener('click', () => {
				void (async () => {
					Debug.log('Open in default app button clicked');
					try {
					const exists = await this.plugin.ignoreManager!.ignoreFileExists();
					if (!exists) {
						await this.plugin.ignoreManager!.createDefaultIgnoreFile();
					}
					
					const file = this.app.vault.getAbstractFileByPath(stats.filePath);
					Debug.log(`File from vault: ${!!file}, path: ${stats.filePath}`);
					
					// Whether or not Obsidian has the file indexed, we know it exists
					// So let's construct the path directly
					try {
						const adapter = this.app.vault.adapter;
						const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const nodePath = require('path') as typeof import('path');
						const fullPath = nodePath.join(basePath, stats.filePath);
						Debug.log(`Opening file at: ${fullPath}`);

						// Try to access electron shell
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const electron = require('electron') as { shell?: { openPath: (path: string) => Promise<string> } };
						if (electron?.shell) {
							const result = await electron.shell.openPath(fullPath);
							Debug.log(`Shell.openPath result: ${result}`);
							new Notice('📝 .mcpignore file opened in default app');
						} else {
							Debug.log('Electron shell not available');
							new Notice('❌ unable to open in external app');
						}
					} catch (err: unknown) {
						const errMsg = err instanceof Error ? err.message : String(err);
						Debug.log(`Error opening file: ${errMsg}`);
						new Notice(`❌ Failed to open file: ${errMsg}`);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					Debug.log(`Failed to open .mcpignore file: ${message}`);
					new Notice('❌ failed to open .mcpignore file');
				}
				})();
			});

			// Show in system explorer button
			const showButton = buttonContainer.createEl('button', {
				text: 'Show in system explorer'
			});
			showButton.addEventListener('click', () => {
				void (async () => {
					Debug.log('Show in system explorer button clicked');
					try {
					const exists = await this.plugin.ignoreManager!.ignoreFileExists();
					if (!exists) {
						await this.plugin.ignoreManager!.createDefaultIgnoreFile();
					}
					
					// Construct path directly, don't rely on Obsidian's file cache
					try {
						const adapter = this.app.vault.adapter;
						const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const nodePath = require('path') as typeof import('path');
						const fullPath = nodePath.join(basePath, stats.filePath);
						Debug.log(`Showing file in explorer: ${fullPath}`);

						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const electron = require('electron') as { shell?: { showItemInFolder: (path: string) => void } };
						if (electron?.shell) {
							electron.shell.showItemInFolder(fullPath);
							new Notice('📁 .mcpignore file location shown in explorer');
						} else {
							Debug.log('Electron shell not available for show in folder');
							new Notice('❌ system explorer not available');
						}
					} catch (err: unknown) {
						const errMsg = err instanceof Error ? err.message : String(err);
						Debug.log(`Error showing file in folder: ${errMsg}`);
						new Notice(`❌ Failed to show file: ${errMsg}`);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					Debug.log(`Failed to show .mcpignore file: ${message}`);
					new Notice('❌ failed to show file location');
				}
				})();
			});

			// Create template button
			const templateButton = buttonContainer.createEl('button', {
				text: 'Create template'
			});
			templateButton.addEventListener('click', () => {
				void (async () => {
					try {
						// Check if file already exists
						const exists = await this.plugin.ignoreManager!.ignoreFileExists();
						if (exists) {
							new Notice('⚠️ .mcpignore file already exists');
							return;
						}

						await this.plugin.ignoreManager!.createDefaultIgnoreFile();
						// Force reload to ensure fresh state
						await this.plugin.ignoreManager!.forceReload();
						new Notice('📄 default .mcpignore template created');
						this.display(); // Refresh to update status
					} catch (error) {
						Debug.log('Failed to create .mcpignore template:', error);
						new Notice('❌ failed to create template');
					}
				})();
			});

			// Reload patterns button
			const reloadButton = buttonContainer.createEl('button', {
				text: 'Reload patterns'
			});
			reloadButton.addEventListener('click', () => {
				void (async () => {
					try {
						await this.plugin.ignoreManager!.forceReload();
						new Notice('🔄 exclusion patterns reloaded');
						this.display(); // Refresh to update status
					} catch (error) {
						Debug.log('Failed to reload patterns:', error);
						new Notice('❌ failed to reload patterns');
					}
				})();
			});

			// Help text
			const helpEl = exclusionSection.createDiv('mcp-exclusion-help');
			new Setting(helpEl).setName("Pattern examples:").setHeading();
			const examplesList = helpEl.createEl('ul');
			const configDir = this.app.vault.configDir;
			const examples = [
				'private/ - exclude entire directory',
				'*.secret - exclude files by extension',
				'temp/** - exclude deeply nested paths',
				'!file.md - include exception (whitelist)',
				`${configDir}/workspace* - exclude workspace files`
			];
			
			examples.forEach(example => {
				examplesList.createEl('li', {
					text: example,
					cls: 'setting-item-description mcp-security-note'
				});
			});

			helpEl.createEl('p', {
				text: 'Full syntax documentation: https://git-scm.com/docs/gitignore',
				cls: 'setting-item-description mcp-security-note'
			});
		}
	}

	private createUIOptionsSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Interface").setHeading();

		new Setting(containerEl)
			.setName('Show connection status')
			.setDesc('Show mcp server status in the status bar')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showConnectionStatus)
				.onChange(async (value) => {
					this.plugin.settings.showConnectionStatus = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBar();
				}));

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable detailed debug logging in console')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					Debug.setDebugMode(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Concurrent sessions").setHeading();

		new Setting(containerEl)
			.setName('Enable concurrent sessions for agent swarms')
			.setDesc('Allow multiple mcp clients to connect simultaneously. Required for agent swarms and multi-client setups.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableConcurrentSessions)
				.onChange(async (value) => {
					this.plugin.settings.enableConcurrentSessions = value;
					await this.plugin.saveSettings();
					
					// Show notice about restart requirement
					new Notice('Server restart required for concurrent session changes to take effect');
				}));

		new Setting(containerEl)
			.setName('Maximum concurrent connections')
			.setDesc('Maximum number of simultaneous connections allowed (1-100, default: 32)')
			.addText(text => text
				.setPlaceholder('32')
				.setValue(this.plugin.settings.maxConcurrentConnections.toString())
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 1 && num <= 100) {
						this.plugin.settings.maxConcurrentConnections = num;
						await this.plugin.saveSettings();
					}
				}))
			.setDisabled(!this.plugin.settings.enableConcurrentSessions);
	}

	private createProtocolInfoSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Mcp protocol information").setHeading();
		
		const info = containerEl.createDiv('mcp-protocol-info');
		
		// Show warning if auth is disabled
		if (this.plugin.settings.dangerouslyDisableAuth) {
			info.createEl('div', {
				text: '⚠️ warning: authentication is disabled. Your vault is accessible without credentials!',
				cls: 'mcp-warning-box'
			});
		}
		
		// Dynamic tools list based on plugin availability
		const baseToolsList = [
			'🗂️ vault - File and folder operations with fragment support',
			'✏️ edit - Smart editing with content buffers', 
			'👁️ view - Content viewing and navigation',
			'🔄 workflow - AI workflow guidance and suggestions',
			'🕸️ graph - Graph traversal and link analysis',
			'⚙️ system - System operations and web fetch'
		];
		
		// Check for optional plugin integrations
		const detector = new PluginDetector(this.app);
		const isDataviewAvailable = detector.isDataviewAPIReady();
		
		const toolsList = [...baseToolsList];
		if (isDataviewAvailable) {
			toolsList.push('📊 dataview - Query vault data with DQL (Dataview plugin detected)');
		}
		
		new Setting(info).setName("").setHeading();
		const toolsListEl = info.createEl('ul');
		toolsList.forEach(tool => {
			toolsListEl.createEl('li', {text: tool});
		});
		
		// Add plugin integration status
		if (isDataviewAvailable) {
			const dataviewStatus = detector.getDataviewStatus();
			info.createEl('p', {
				text: `🔌 Plugin Integrations: Dataview v${dataviewStatus.version} (enabled)`,
				cls: 'plugin-integration-status'
			});
		} else {
			info.createEl('p', {
				text: '🔌 plugin integrations: none detected (install dataview for additional functionality)',
				cls: 'plugin-integration-status'
			});
		}
		
		new Setting(info).setName("").setHeading();
		const resourcesList = info.createEl('ul');
		resourcesList.createEl('li', {text: '📊 Obsidian://vault-info - real-time vault metadata'});
		if (this.plugin.settings.enableConcurrentSessions) {
			resourcesList.createEl('li', {text: '🔄 Obsidian://session-info - active mcp sessions and statistics'});
		}
		
		new Setting(info).setName("Claude code connection").setHeading();
		const commandExample = info.createDiv('protocol-command-example');
		const codeEl = commandExample.createEl('code');
		codeEl.classList.add('mcp-code-block');
		
		// Get correct protocol and port based on HTTPS setting
		const protocol = this.plugin.settings.httpsEnabled ? 'https' : 'http';
		const port = this.plugin.settings.httpsEnabled ? this.plugin.settings.httpsPort : this.plugin.settings.httpPort;
		const baseUrl = `${protocol}://localhost:${port}`;
		
		const claudeCommand = this.plugin.settings.dangerouslyDisableAuth ?
			`claude mcp add --transport http obsidian ${baseUrl}/mcp` :
			`claude mcp add --transport http obsidian ${baseUrl}/mcp --header "Authorization: Bearer ${this.plugin.settings.apiKey}"`;

		codeEl.textContent = claudeCommand;

		// Add copy button
		this.addCopyButton(commandExample, claudeCommand);
		
		new Setting(info).setName("Client configuration (claude desktop, cline, etc.)").setHeading();
		info.createEl('p', {
			text: 'Add this to your mcp client configuration file:'
		});
		
		// Option 1: Direct HTTP Transport
		info.createEl('p', {text: 'Option 1: direct HTTP transport (if supported by your client):', cls: 'mcp-section-header'});
		const configExample = info.createDiv('desktop-config-example');
		const configEl = configExample.createEl('pre');
		configEl.classList.add('mcp-config-example');
		
		const configJson = this.plugin.settings.dangerouslyDisableAuth ? {
			"mcpServers": {
				[this.app.vault.getName()]: {
					"transport": {
						"type": "http",
						"url": `${baseUrl}/mcp`
					}
				}
			}
		} : {
			"mcpServers": {
				[this.app.vault.getName()]: {
					"transport": {
						"type": "http",
						"url": `${protocol}://obsidian:${this.plugin.settings.apiKey}@localhost:${port}/mcp`
					}
				}
			}
		};

		const configJsonText = JSON.stringify(configJson, null, 2);
		configEl.textContent = configJsonText;

		// Add copy button
		this.addCopyButton(configExample, configJsonText);

		// Option 2: Via mcp-remote
		info.createEl('p', {text: 'Option 2: via mcp-remote (for claude desktop):', cls: 'mcp-section-header'});
		info.createEl('p', {
			text: 'Mcp-remote supports authentication headers via the --header flag:',
			cls: 'setting-item-description mcp-security-note'
		});
		
		const remoteExample = info.createDiv('desktop-config-example');
		const remoteEl = remoteExample.createEl('pre');
		remoteEl.classList.add('mcp-config-example');
		
		// Check if we're using self-signed certificates (HTTPS enabled and auto-generate is on)
		const isUsingSelfSignedCert = this.plugin.settings.httpsEnabled && 
			(this.plugin.settings.certificateConfig.autoGenerate !== false || 
			!this.plugin.settings.certificateConfig.certPath);
		
		const vaultName = this.app.vault.getName();
		const remoteEntry: MCPServerEntry = {
			command: "npx",
			args: this.plugin.settings.dangerouslyDisableAuth
				? ["mcp-remote", `${baseUrl}/mcp`]
				: ["mcp-remote", `${baseUrl}/mcp`, "--header", `Authorization: Bearer ${this.plugin.settings.apiKey}`]
		};
		if (isUsingSelfSignedCert) {
			remoteEntry.env = { "NODE_TLS_REJECT_UNAUTHORIZED": "0" };
		}
		const remoteJson: MCPClientConfig = {
			mcpServers: { [vaultName]: remoteEntry }
		};

		const remoteJsonText = JSON.stringify(remoteJson, null, 2);
		remoteEl.textContent = remoteJsonText;

		// Add copy button
		this.addCopyButton(remoteExample, remoteJsonText);

		// Add note about self-signed certificates if applicable
		if (isUsingSelfSignedCert) {
			info.createEl('p', {
				text: '📝 self-signed certificate detected: node_TLS_reject_unauthorized=0 is included to allow the secure connection.',
				cls: 'setting-item-description mcp-cert-note'
			});
		}
		
		// Option 2a: Windows Configuration
		info.createEl('p', {text: 'Option 2a: Windows configuration (via mcp-remote):', cls: 'mcp-section-header'});
		info.createEl('p', {
			text: 'Windows has issues with spaces in npx arguments. Use environment variables to work around this:',
			cls: 'setting-item-description mcp-security-note'
		});
		
		const windowsExample = info.createDiv('desktop-config-example');
		const windowsEl = windowsExample.createEl('pre');
		windowsEl.classList.add('mcp-config-example');
		
		const windowsEntry: MCPServerEntry = {
			command: "npx",
			args: this.plugin.settings.dangerouslyDisableAuth
				? ["mcp-remote", `${baseUrl}/mcp`]
				: ["mcp-remote", `${baseUrl}/mcp`, "--header", "Authorization:${OBSIDIAN_API_KEY}"]
		};
		const windowsEnv: Record<string, string> = {};
		if (!this.plugin.settings.dangerouslyDisableAuth) {
			windowsEnv["OBSIDIAN_API_KEY"] = `Bearer ${this.plugin.settings.apiKey}`;
		}
		if (isUsingSelfSignedCert) {
			windowsEnv["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
		}
		if (Object.keys(windowsEnv).length > 0) {
			windowsEntry.env = windowsEnv;
		}
		const windowsJson: MCPClientConfig = {
			mcpServers: { [vaultName]: windowsEntry }
		};

		const windowsJsonText = JSON.stringify(windowsJson, null, 2);
		windowsEl.textContent = windowsJsonText;

		// Add copy button
		this.addCopyButton(windowsExample, windowsJsonText);

		const configPath = info.createEl('p', {
			text: 'Configuration file location:'
		});
		configPath.classList.add('mcp-config-path');
		
		const pathList = configPath.createEl('ul');
		pathList.createEl('li', {text: 'macOS: ~/Library/Application Support/Claude/claude_desktop_config.json'});
		pathList.createEl('li', {text: 'Windows: %APPDATA%\\Claude\\claude_desktop_config.json'});
		pathList.createEl('li', {text: 'Linux: ~/.config/Claude/claude_desktop_config.json'});
	}

	private addCopyButton(container: HTMLElement, textToCopy: string): void {
		// Ensure container has relative positioning for absolute button placement
		container.classList.add('mcp-config-container');

		// Create copy button
		const copyButton = container.createEl('button', {
			cls: 'mcp-copy-button'
		});
		copyButton.setAttribute('aria-label', 'Copy to clipboard');
		setIcon(copyButton, 'copy');
				copyButton.classList.remove('success');

		// Style the button

		// Hover effect
		copyButton.addEventListener('mouseenter', () => {
		});

		copyButton.addEventListener('mouseleave', () => {
		});

		// Click handler
		copyButton.addEventListener('click', () => {
			void (async () => {
				try {
					await navigator.clipboard.writeText(textToCopy);

					// Show success feedback
					copyButton.classList.add('success');
					setIcon(copyButton, 'check');

					// Reset after 2 seconds
					setTimeout(() => {
						setIcon(copyButton, 'copy');
						copyButton.classList.remove('success');
					}, 2000);
				} catch (error) {
					new Notice('Failed to copy to clipboard');
					Debug.error('Failed to copy to clipboard:', error);
				}
			})();
		});
	}

	private async checkPortAvailability(port: number, setting: Setting): Promise<void> {
		if (!this.plugin.settings.autoDetectPortConflicts) return;
		
		const status = await this.plugin.checkPortConflict(port);
		
		switch (status) {
			case 'available':
				setting.setDesc("Port for HTTP mcp server (default: 3001) ✅ available");
				break;
			case 'this-server':
				setting.setDesc("Port for HTTP mcp server (default: 3001) 🟢 this server");
				break;
			case 'in-use':
				setting.setDesc(`Port for HTTP MCP server (default: 3001) ⚠️ Port ${port} in use`);
				break;
			default:
				setting.setDesc('Port for HTTP mcp server (default: 3001)');
		}
	}
	
	private async checkHttpsPortAvailability(port: number, setting: Setting): Promise<void> {
		if (!this.plugin.settings.autoDetectPortConflicts) return;
		
		const status = await this.plugin.checkPortConflict(port);
		
		switch (status) {
			case 'available':
				setting.setDesc("Port for HTTPS mcp server (default: 3443) ✅ available");
				break;
			case 'this-server':
				setting.setDesc("Port for HTTPS mcp server (default: 3443) 🟢 this server");
				break;
			case 'in-use':
				setting.setDesc(`Port for HTTPS MCP server (default: 3443) ⚠️ Port ${port} in use`);
				break;
			default:
				setting.setDesc('Port for HTTPS mcp server (default: 3443)');
		}
	}

	refreshConnectionStatus(): void {
		// Simply refresh the entire settings display to ensure accurate data
		// This is more reliable than trying to manually update DOM elements
		this.display();
	}

	private updatePortApplyButton(setting: Setting, hasChanges: boolean, pendingPort: number): void {
		const button = setting.components.find((c): c is ButtonComponent => c instanceof ButtonComponent);
		if (button) {
			if (hasChanges) {
				button.buttonEl.classList.remove('mcp-hidden');
				setting.setDesc(`Port for HTTP MCP server (default: 3001) - Click Apply to change to ${pendingPort}`);
			} else {
				button.buttonEl.classList.add('mcp-hidden');
				setting.setDesc('Port for HTTP mcp server (default: 3001)');
			}
		}
	}

	updateLiveStats(): void {
		// Update all dynamic elements in the settings panel without rebuilding
		const info = this.plugin.getMCPServerInfo();
		
		// Update connection status grid
		const connectionEl = document.querySelector('.mcp-status-grid');
		if (connectionEl) {
			const connectionItems = connectionEl.querySelectorAll('div');
			for (let i = 0; i < connectionItems.length; i++) {
				const item = connectionItems[i];
				const text = item.textContent || '';
				const valueSpan = item.querySelector('span');
				
				if (text.includes('Status:') && valueSpan) {
					valueSpan.textContent = info.running ? 'Running' : 'Stopped';
					valueSpan.classList.remove('mcp-status-value', 'success', 'error');
					valueSpan.classList.add('mcp-status-value', info.running ? 'success' : 'error');
				} else if (text.includes('Port:') && valueSpan) {
					valueSpan.textContent = info.port.toString();
				} else if (text.includes('Connections:') && valueSpan) {
					valueSpan.textContent = info.connections.toString();
				}
			}
		}
		
		// Update protocol information section with proper auth handling
		const protocolSection = document.querySelector('.protocol-command-example');
		if (protocolSection) {
			const codeBlock = protocolSection.querySelector('code');
			if (codeBlock && info) {
				// Get correct protocol and port based on HTTPS setting
				const protocol = this.plugin.settings.httpsEnabled ? 'https' : 'http';
				const port = this.plugin.settings.httpsEnabled ? this.plugin.settings.httpsPort : info.port;
				const baseUrl = `${protocol}://localhost:${port}`;
				
				const claudeCommand = this.plugin.settings.dangerouslyDisableAuth ? 
					`claude mcp add --transport http obsidian ${baseUrl}/mcp` :
					`claude mcp add --transport http obsidian ${baseUrl}/mcp --header "Authorization: Bearer ${this.plugin.settings.apiKey}"`;
				
				codeBlock.textContent = claudeCommand;
			}
		}
		
		// Update any other dynamic content areas that need live updates
		const statusElements = document.querySelectorAll('[data-live-update]');
		for (let i = 0; i < statusElements.length; i++) {
			const el = statusElements[i];
			const updateType = el.getAttribute('data-live-update');
			switch (updateType) {
				case 'server-status':
					el.textContent = info.running ? 'Running' : 'Stopped';
					break;
				case 'connection-count':
					el.textContent = info.connections.toString();
					break;
				case 'server-port':
					el.textContent = info.port.toString();
					break;
			}
		}
	}

	private handleEasterEggClick(): void {
		if (this.easterEggTimeout) {
			window.clearTimeout(this.easterEggTimeout);
		}
		this.easterEggClicks++;
		this.easterEggTimeout = window.setTimeout(() => {
			this.easterEggClicks = 0;
		}, 3000);
		if (this.easterEggClicks >= 7) {
			this.easterEggClicks = 0;
			new NoteTakingEnthusiastModal(this.app).open();
		}
	}
}

class NoteTakingEnthusiastModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('mcp-easter-egg-modal');
		contentEl.createEl('h2', { text: 'You found the secret!' });
		const imageContainer = contentEl.createDiv('mcp-easter-egg-image-container');
		const img = imageContainer.createEl('img', { cls: 'mcp-easter-egg-image' });
		img.src = 'data:image/jpeg;base64,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';
		img.alt = 'Note Taking Enthusiast';
		contentEl.createEl('p', { text: 'Thanks for being an Obsidian enthusiast!', cls: 'mcp-easter-egg-thanks' });
	}
	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmationModal extends Modal {
	private message: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: this.message });

		const buttonContainer = contentEl.createDiv('modal-button-container');

		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const confirmButton = buttonContainer.createEl('button', { text: 'Confirm', cls: 'mod-warning' });
		confirmButton.addEventListener('click', () => {
			void Promise.resolve(this.onConfirm()).then(() => this.close());
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
