import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, Menu, setIcon } from 'obsidian';
import { MCPHttpServer } from './mcp-server';
import { getVersion } from './version';
import { Debug } from './utils/debug';
import { MCPIgnoreManager } from './security/mcp-ignore-manager';
import { randomBytes } from 'crypto';
import { createSemanticTools } from './tools/semantic-tools';
import { PluginDetector } from './utils/plugin-detector';
import { CertificateConfig } from './utils/certificate-manager';

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
	enableIgnoreContextMenu: false // Context menu disabled by default
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
				name: 'Restart MCP Server',
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

	async onunload() {
		Debug.log('👋 Unloading Obsidian MCP Plugin');
		
		// Clear vault monitoring
		if (this.vaultSwitchTimeout) {
			window.clearTimeout(this.vaultSwitchTimeout);
		}
		
		// Clear stats updates
		if (this.statsUpdateInterval) {
			window.clearInterval(this.statsUpdateInterval);
		}
		
		await this.stopMCPServer();
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
			Debug.error('❌ Failed to start MCP server:', error);
			new Notice(`Failed to start MCP server: ${error}`);
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
		
		if (!this.settings.httpEnabled && !this.settings.httpsEnabled) {
			this.statusBarItem.setText('MCP: Disabled');
			this.statusBarItem.setAttribute('style', 'color: var(--text-muted);');
		} else if (this.mcpServer?.isServerRunning()) {
			const vaultName = this.app.vault.getName();
			const protocols: string[] = [];
			if (this.settings.httpEnabled) protocols.push(`HTTP:${this.settings.httpPort}`);
			if (this.settings.httpsEnabled) protocols.push(`HTTPS:${this.settings.httpsPort}`);
			this.statusBarItem.setText(`MCP: ${vaultName} (${protocols.join(', ')})`);
			this.statusBarItem.setAttribute('style', 'color: var(--text-success);');
		} else {
			this.statusBarItem.setText('MCP: Error');
			this.statusBarItem.setAttribute('style', 'color: var(--text-error);');
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		
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
			const testServer = require('http').createServer();
			return new Promise((resolve) => {
				testServer.listen(port, '127.0.0.1', () => {
					testServer.close(() => resolve('available')); // Port is available
				});
				testServer.on('error', () => resolve('in-use')); // Port is in use
			});
		} catch (error) {
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

	getMCPServerInfo(): any {
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
			const settingsTab = (this.app as any).setting?.activeTab;
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
			return (this.app.vault.adapter as any).basePath || '';
		} catch (error) {
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
								} catch (readError) {
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
							} catch (error: any) {
								Debug.log('Failed to add to .mcpignore:', error);
								const errorMsg = error?.message || 'Unknown error';
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
			
			this.handleVaultSwitch(
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
			
			this.vaultSwitchTimeout = window.setTimeout(async () => {
				await this.stopMCPServer();
				await this.startMCPServer();
				Debug.log(`✅ MCP server restarted for vault: ${newVaultName}`);
			}, 1000); // 1 second delay
		}

		// Update status bar to reflect new vault
		this.updateStatusBar();
	}
}

class MCPSettingTab extends PluginSettingTab {
	plugin: ObsidianMCPPlugin;

	constructor(app: App, plugin: ObsidianMCPPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Semantic Notes Vault MCP Settings'});

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
		statusEl.createEl('h3', {text: 'Connection Status'});
		
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
			createStatusItem('Version', info.version);
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
		containerEl.createEl('h3', {text: 'Server Configuration'});

		new Setting(containerEl)
			.setName('Enable HTTP Server')
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
			.setName('HTTP Port')
			.setDesc('Port for HTTP MCP server (default: 3001)')
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
							this.checkPortAvailability(port, portSetting);
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
						const textComponent = portSetting.components.find(c => (c as any).inputEl) as any;
						const newPort = parseInt(textComponent.inputEl.value);
						
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
							portSetting.setDesc('Port for HTTP MCP server (default: 3001)');
						}
					});
				
				// Initially hide the apply button
				button.buttonEl.classList.add('mcp-hidden');
				return button;
			});
		
		// Don't check port availability on load - only when changed or server starts
		// This avoids detecting our own running server as a conflict

		new Setting(containerEl)
			.setName('Auto-detect Port Conflicts')
			.setDesc('Automatically detect and warn about port conflicts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoDetectPortConflicts)
				.onChange(async (value) => {
					this.plugin.settings.autoDetectPortConflicts = value;
					await this.plugin.saveSettings();
				}));
	}
	
	private createHTTPSConfigSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', {text: 'HTTPS/TLS Configuration'});
		
		new Setting(containerEl)
			.setName('Enable HTTPS Server')
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
				.setName('HTTPS Port')
				.setDesc('Port for HTTPS MCP server (default: 3443)')
				.addText(text => text
					.setPlaceholder('3443')
					.setValue(this.plugin.settings.httpsPort.toString())
					.onChange(async (value) => {
						const port = parseInt(value);
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.httpsPort = port;
							await this.plugin.saveSettings();
							// Check port availability for HTTPS
							this.checkHttpsPortAvailability(port, httpsPortSetting);
						}
					}));
			
			// Don't check HTTPS port availability on load - only when changed or server starts
			// This avoids detecting our own running server as a conflict
			
			new Setting(containerEl)
				.setName('Auto-generate Certificate')
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
				.setName('Certificate Path')
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
				.setName('Key Path')
				.setDesc('Path to private key file (.key) - leave empty for auto-generated')
				.addText(text => text
					.setPlaceholder('Leave empty for auto-generated')
					.setValue(this.plugin.settings.certificateConfig.keyPath || '')
					.onChange(async (value) => {
						this.plugin.settings.certificateConfig.keyPath = value || undefined;
						await this.plugin.saveSettings();
					}));
			
			new Setting(containerEl)
				.setName('Minimum TLS Version')
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
			statusEl.createEl('h4', {text: 'Certificate Status'});
			
			// Check certificate status asynchronously
			import('./utils/certificate-manager').then(module => {
				const certManager = new module.CertificateManager(this.app);
			if (certManager.hasDefaultCertificate()) {
				const paths = certManager.getDefaultPaths();
				const loaded = certManager.loadCertificate(paths.certPath, paths.keyPath);
				if (loaded) {
					const info = certManager.getCertificateInfo(loaded.cert);
					if (info) {
						statusEl.createEl('p', {
							text: `✅ Certificate valid until: ${info.validTo.toLocaleDateString()}`,
							cls: 'setting-item-description'
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
					text: '📝 No certificate found - will auto-generate on server start',
					cls: 'setting-item-description'
				});
			}
			});
		}
	}
	
	private createAuthenticationSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', {text: 'Authentication'});
		
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Secure API key for authenticating MCP clients')
			.addText(text => {
				const input = text
					.setPlaceholder('API key will be shown here')
					.setValue(this.plugin.settings.apiKey)
					.setDisabled(true);
				
				// Make the text input wider to accommodate the key
				input.inputEl.style.width = '300px';
				input.inputEl.style.fontFamily = 'monospace';
				
				// Add a class for styling
				input.inputEl.classList.add('mcp-api-key-input');
				
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
				.onClick(async () => {
					// Show confirmation dialog
					const confirmed = confirm('Are you sure you want to regenerate the API key? This will invalidate the current key and require updating all MCP clients.');
					
					if (confirmed) {
						this.plugin.settings.apiKey = this.plugin.generateApiKey();
						await this.plugin.saveSettings();
						new Notice('API key regenerated. Update your MCP clients with the new key.');
						this.display(); // Refresh the settings display
					}
				}));
		
		// Add a note about security
		const securityNote = containerEl.createEl('p', {
			text: 'Note: The API key is stored in the plugin settings file. Anyone with access to your vault can read it.',
			cls: 'setting-item-description'
		});
		securityNote.style.marginTop = '-10px';
		securityNote.style.marginBottom = '10px';
		
		// Add note about auth methods
		const authNote = containerEl.createEl('p', {
			text: 'Supports both Bearer token (recommended) and Basic authentication.',
			cls: 'setting-item-description'
		});
		authNote.style.marginTop = '-10px';
		authNote.style.marginBottom = '20px';
		
		// Add dangerous disable auth toggle
		new Setting(containerEl)
			.setName('Disable Authentication')
			.setDesc('⚠️ DANGEROUS: Disable authentication entirely. Only use for testing or if you fully trust your local environment.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dangerouslyDisableAuth)
				.onChange(async (value) => {
					this.plugin.settings.dangerouslyDisableAuth = value;
					await this.plugin.saveSettings();
					
					// Show warning if disabling auth
					if (value) {
						new Notice('⚠️ Authentication disabled! Your vault is accessible without credentials.');
					} else {
						new Notice('✅ Authentication enabled. API key required for access.');
					}
					
					// Refresh display to update examples
					this.display();
				}));
	}

	private createSecuritySection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', {text: 'Security'});
		
		new Setting(containerEl)
			.setName('Read-Only Mode')
			.setDesc('Enable read-only mode - blocks all write operations (create, update, delete, move, rename)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.readOnlyMode)
				.onChange(async (value) => {
					this.plugin.settings.readOnlyMode = value;
					await this.plugin.saveSettings();
					
					// Debug logging for read-only mode changes
					if (value) {
						Debug.log('🔒 READ-ONLY MODE ENABLED via settings - Server restart required for activation');
						new Notice('🔒 Read-only mode enabled. All write operations are blocked.');
					} else {
						Debug.log('✅ READ-ONLY MODE DISABLED via settings - Server restart required for deactivation');
						new Notice('✅ Read-only mode disabled. All operations are allowed.');
					}
					
					// Refresh display to update examples
					this.display();
				}));

		// Path Exclusions Setting
		new Setting(containerEl)
			.setName('Path Exclusions')
			.setDesc('Exclude files and directories from MCP operations using .gitignore-style patterns')
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
							new Notice('✅ Path exclusions enabled');
						} else {
							Debug.log('🔓 Path exclusions disabled');
							new Notice('🔓 Path exclusions disabled');
						}
					}
					
					// Refresh display to show/hide file management options
					this.display();
				}));

		// Show context menu toggle if path exclusions are enabled
		if (this.plugin.settings.pathExclusionsEnabled) {
			new Setting(containerEl)
				.setName('Enable right-click context menu')
				.setDesc('Add "Add to .mcpignore" option to file/folder context menus')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enableIgnoreContextMenu)
					.onChange(async (value) => {
						this.plugin.settings.enableIgnoreContextMenu = value;
						await this.plugin.saveSettings();
						
						if (value) {
							this.plugin.registerContextMenu();
							new Notice('✅ Context menu enabled - restart required for full effect');
						} else {
							new Notice('🔓 Context menu disabled - restart required for full effect');
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
		exclusionSection.createEl('h4', {text: '.mcpignore File Management'});

		if (this.plugin.ignoreManager) {
			Debug.log('Ignore manager available, creating buttons');
			const stats = this.plugin.ignoreManager.getStats();
			
			// Status info
			const statusEl = exclusionSection.createDiv('mcp-exclusion-status');
			statusEl.createEl('p', {
				text: `Current exclusions: ${stats.patternCount} patterns active`,
				cls: 'setting-item-description'
			});
			
			// Helper text
			statusEl.createEl('p', {
				text: 'Save patterns in .mcpignore file before reloading',
				cls: 'setting-item-description'
			});
			
			if (stats.lastModified > 0) {
				statusEl.createEl('p', {
					text: `Last modified: ${new Date(stats.lastModified).toLocaleString()}`,
					cls: 'setting-item-description'
				});
			}

			// File management buttons
			const buttonContainer = exclusionSection.createDiv('mcp-exclusion-buttons');
			
			// Open in default app button
			const openButton = buttonContainer.createEl('button', {
				text: 'Open in default app',
				cls: 'mod-cta'
			});
			openButton.addEventListener('click', async () => {
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
						const adapter = this.app.vault.adapter as any;
						const path = require('path');
						const fullPath = path.join(adapter.basePath || '', stats.filePath);
						Debug.log(`Opening file at: ${fullPath}`);
						
						// Try to access electron shell
						const electron = require('electron');
						if (electron?.shell) {
							const result = await electron.shell.openPath(fullPath);
							Debug.log(`Shell.openPath result: ${result}`);
							new Notice('📝 .mcpignore file opened in default app');
						} else {
							Debug.log('Electron shell not available');
							new Notice('❌ Unable to open in external app');
						}
					} catch (err: any) {
						Debug.log(`Error opening file: ${err?.message || err}`);
						new Notice('❌ Failed to open file: ' + (err?.message || err));
					}
				} catch (error) {
					Debug.log(`Failed to open .mcpignore file: ${error}`);
					new Notice('❌ Failed to open .mcpignore file');
				}
			});

			// Show in system explorer button
			const showButton = buttonContainer.createEl('button', {
				text: 'Show in system explorer'
			});
			showButton.addEventListener('click', async () => {
				Debug.log('Show in system explorer button clicked');
				try {
					const exists = await this.plugin.ignoreManager!.ignoreFileExists();
					if (!exists) {
						await this.plugin.ignoreManager!.createDefaultIgnoreFile();
					}
					
					// Construct path directly, don't rely on Obsidian's file cache
					try {
						const adapter = this.app.vault.adapter as any;
						const path = require('path');
						const fullPath = path.join(adapter.basePath || '', stats.filePath);
						Debug.log(`Showing file in explorer: ${fullPath}`);
						
						const electron = require('electron');
						if (electron?.shell) {
							electron.shell.showItemInFolder(fullPath);
							new Notice('📁 .mcpignore file location shown in explorer');
						} else {
							Debug.log('Electron shell not available for show in folder');
							new Notice('❌ System explorer not available');
						}
					} catch (err: any) {
						Debug.log(`Error showing file in folder: ${err?.message || err}`);
						new Notice('❌ Failed to show file: ' + (err?.message || err));
					}
				} catch (error) {
					Debug.log(`Failed to show .mcpignore file: ${error}`);
					new Notice('❌ Failed to show file location');
				}
			});

			// Create template button
			const templateButton = buttonContainer.createEl('button', {
				text: 'Create Template'
			});
			templateButton.addEventListener('click', async () => {
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
					new Notice('📄 Default .mcpignore template created');
					this.display(); // Refresh to update status
				} catch (error) {
					Debug.log('Failed to create .mcpignore template:', error);
					new Notice('❌ Failed to create template');
				}
			});

			// Reload patterns button
			const reloadButton = buttonContainer.createEl('button', {
				text: 'Reload Patterns'
			});
			reloadButton.addEventListener('click', async () => {
				try {
					await this.plugin.ignoreManager!.forceReload();
					new Notice('🔄 Exclusion patterns reloaded');
					this.display(); // Refresh to update status
				} catch (error) {
					Debug.log('Failed to reload patterns:', error);
					new Notice('❌ Failed to reload patterns');
				}
			});

			// Help text
			const helpEl = exclusionSection.createDiv('mcp-exclusion-help');
			helpEl.createEl('h5', {text: 'Pattern Examples:'});
			const examplesList = helpEl.createEl('ul');
			const examples = [
				'private/ - exclude entire directory',
				'*.secret - exclude files by extension',
				'temp/** - exclude deeply nested paths',
				'!file.md - include exception (whitelist)',
				'.obsidian/workspace* - exclude workspace files'
			];
			
			examples.forEach(example => {
				examplesList.createEl('li', {
					text: example,
					cls: 'setting-item-description'
				});
			});

			helpEl.createEl('p', {
				text: 'Full syntax documentation: https://git-scm.com/docs/gitignore',
				cls: 'setting-item-description'
			});
		}
	}

	private createUIOptionsSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', {text: 'Interface Options'});

		new Setting(containerEl)
			.setName('Show Connection Status')
			.setDesc('Show MCP server status in the status bar')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showConnectionStatus)
				.onChange(async (value) => {
					this.plugin.settings.showConnectionStatus = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBar();
				}));

		new Setting(containerEl)
			.setName('Debug Logging')
			.setDesc('Enable detailed debug logging in console')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					Debug.setDebugMode(value);
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', {text: 'Concurrent Sessions'});

		new Setting(containerEl)
			.setName('Enable Concurrent Sessions for Agent Swarms')
			.setDesc('Allow multiple MCP clients to connect simultaneously. Required for agent swarms and multi-client setups.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableConcurrentSessions)
				.onChange(async (value) => {
					this.plugin.settings.enableConcurrentSessions = value;
					await this.plugin.saveSettings();
					
					// Show notice about restart requirement
					new Notice('Server restart required for concurrent session changes to take effect');
				}));

		new Setting(containerEl)
			.setName('Maximum Concurrent Connections')
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
		containerEl.createEl('h3', {text: 'MCP Protocol Information'});
		
		const info = containerEl.createDiv('mcp-protocol-info');
		
		// Show warning if auth is disabled
		if (this.plugin.settings.dangerouslyDisableAuth) {
			const warningEl = info.createEl('div', {
				text: '⚠️ WARNING: Authentication is disabled. Your vault is accessible without credentials!',
				cls: 'mcp-auth-warning'
			});
			warningEl.style.backgroundColor = 'var(--background-modifier-error)';
			warningEl.style.color = 'var(--text-error)';
			warningEl.style.padding = '10px';
			warningEl.style.borderRadius = '5px';
			warningEl.style.marginBottom = '15px';
			warningEl.style.fontWeight = 'bold';
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
		
		const toolCount = toolsList.length;
		info.createEl('h4', {text: `Available Tools (${toolCount})`});
		const toolsListEl = info.createEl('ul');
		toolsList.forEach(tool => {
			toolsListEl.createEl('li', {text: tool});
		});
		
		// Add plugin integration status
		if (isDataviewAvailable) {
			const dataviewStatus = detector.getDataviewStatus();
			const statusEl = info.createEl('p', {
				text: `🔌 Plugin Integrations: Dataview v${dataviewStatus.version} (enabled)`,
				cls: 'plugin-integration-status'
			});
			statusEl.style.color = 'var(--text-success)';
			statusEl.style.fontSize = '0.9em';
			statusEl.style.marginTop = '10px';
		} else {
			const statusEl = info.createEl('p', {
				text: '🔌 Plugin Integrations: None detected (install Dataview for additional functionality)',
				cls: 'plugin-integration-status'
			});
			statusEl.style.color = 'var(--text-muted)';
			statusEl.style.fontSize = '0.9em';
			statusEl.style.marginTop = '10px';
		}
		
		const resourceCount = this.plugin.settings.enableConcurrentSessions ? 2 : 1;
		info.createEl('h4', {text: `Available Resources (${resourceCount})`});
		const resourcesList = info.createEl('ul');
		resourcesList.createEl('li', {text: '📊 obsidian://vault-info - Real-time vault metadata'});
		if (this.plugin.settings.enableConcurrentSessions) {
			resourcesList.createEl('li', {text: '🔄 obsidian://session-info - Active MCP sessions and statistics'});
		}
		
		info.createEl('h4', {text: 'Claude Code Connection'});
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
		
		info.createEl('h4', {text: 'Client Configuration (Claude Desktop, Cline, etc.)'});
		const desktopDesc = info.createEl('p', {
			text: 'Add this to your MCP client configuration file:'
		});
		
		// Option 1: Direct HTTP Transport
		info.createEl('p', {text: 'Option 1: Direct HTTP Transport (if supported by your client):'}).style.fontWeight = 'bold';
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
		info.createEl('p', {text: 'Option 2: Via mcp-remote (for Claude Desktop):'}).style.fontWeight = 'bold';
		const remoteDesc = info.createEl('p', {
			text: 'mcp-remote supports authentication headers via the --header flag:',
			cls: 'setting-item-description'
		});
		
		const remoteExample = info.createDiv('desktop-config-example');
		const remoteEl = remoteExample.createEl('pre');
		remoteEl.classList.add('mcp-config-example');
		
		// Check if we're using self-signed certificates (HTTPS enabled and auto-generate is on)
		const isUsingSelfSignedCert = this.plugin.settings.httpsEnabled && 
			(this.plugin.settings.certificateConfig.autoGenerate !== false || 
			!this.plugin.settings.certificateConfig.certPath);
		
		let remoteJson: any;
		if (this.plugin.settings.dangerouslyDisableAuth) {
			remoteJson = {
				"mcpServers": {
					[this.app.vault.getName()]: {
						"command": "npx",
						"args": [
							"mcp-remote",
							`${baseUrl}/mcp`
						]
					}
				}
			};
			// Add NODE_TLS env var if using self-signed cert
			if (isUsingSelfSignedCert) {
				remoteJson.mcpServers[this.app.vault.getName()].env = {
					"NODE_TLS_REJECT_UNAUTHORIZED": "0"
				};
			}
		} else {
			remoteJson = {
				"mcpServers": {
					[this.app.vault.getName()]: {
						"command": "npx",
						"args": [
							"mcp-remote",
							`${baseUrl}/mcp`,
							"--header",
							`Authorization: Bearer ${this.plugin.settings.apiKey}`
						]
					}
				}
			};
			// Add NODE_TLS env var if using self-signed cert
			if (isUsingSelfSignedCert) {
				remoteJson.mcpServers[this.app.vault.getName()].env = {
					"NODE_TLS_REJECT_UNAUTHORIZED": "0"
				};
			}
		}

		const remoteJsonText = JSON.stringify(remoteJson, null, 2);
		remoteEl.textContent = remoteJsonText;

		// Add copy button
		this.addCopyButton(remoteExample, remoteJsonText);

		// Add note about self-signed certificates if applicable
		if (isUsingSelfSignedCert) {
			const certNote = info.createEl('p', {
				text: '📝 Self-signed certificate detected: NODE_TLS_REJECT_UNAUTHORIZED=0 is included to allow the secure connection.',
				cls: 'setting-item-description'
			});
			certNote.style.fontStyle = 'italic';
			certNote.style.color = 'var(--text-muted)';
		}
		
		// Option 2a: Windows Configuration
		info.createEl('p', {text: 'Option 2a: Windows Configuration (via mcp-remote):'}).style.fontWeight = 'bold';
		const windowsNote = info.createEl('p', {
			text: 'Windows has issues with spaces in npx arguments. Use environment variables to work around this:',
			cls: 'setting-item-description'
		});
		
		const windowsExample = info.createDiv('desktop-config-example');
		const windowsEl = windowsExample.createEl('pre');
		windowsEl.classList.add('mcp-config-example');
		
		const windowsJson: any = {
			"mcpServers": {
				[this.app.vault.getName()]: {
					"command": "npx",
					"args": this.plugin.settings.dangerouslyDisableAuth ?
						[
							"mcp-remote",
							`${baseUrl}/mcp`
						] :
						[
							"mcp-remote",
							`${baseUrl}/mcp`,
							"--header",
							"Authorization:${OBSIDIAN_API_KEY}"
						]
				}
			}
		};

		// Add env section if auth is enabled
		if (!this.plugin.settings.dangerouslyDisableAuth) {
			windowsJson.mcpServers[this.app.vault.getName()].env = {
				"OBSIDIAN_API_KEY": `Bearer ${this.plugin.settings.apiKey}`
			};
		}

		// Add NODE_TLS env var if using self-signed cert
		if (isUsingSelfSignedCert) {
			if (!windowsJson.mcpServers[this.app.vault.getName()].env) {
				windowsJson.mcpServers[this.app.vault.getName()].env = {};
			}
			windowsJson.mcpServers[this.app.vault.getName()].env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
		}

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
		container.style.position = 'relative';

		// Create copy button
		const copyButton = container.createEl('button', {
			cls: 'mcp-copy-button'
		});
		copyButton.setAttribute('aria-label', 'Copy to clipboard');
		setIcon(copyButton, 'copy');

		// Style the button
		copyButton.style.position = 'absolute';
		copyButton.style.top = '8px';
		copyButton.style.right = '8px';
		copyButton.style.padding = '4px';
		copyButton.style.background = 'var(--interactive-normal)';
		copyButton.style.border = '1px solid var(--background-modifier-border)';
		copyButton.style.borderRadius = '4px';
		copyButton.style.cursor = 'pointer';
		copyButton.style.opacity = '0.7';
		copyButton.style.transition = 'opacity 0.2s, background 0.2s';

		// Hover effect
		copyButton.addEventListener('mouseenter', () => {
			copyButton.style.opacity = '1';
			copyButton.style.background = 'var(--interactive-hover)';
		});

		copyButton.addEventListener('mouseleave', () => {
			copyButton.style.opacity = '0.7';
			copyButton.style.background = 'var(--interactive-normal)';
		});

		// Click handler
		copyButton.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(textToCopy);

				// Show success feedback
				setIcon(copyButton, 'check');
				copyButton.style.background = 'var(--interactive-success)';

				// Reset after 2 seconds
				setTimeout(() => {
					setIcon(copyButton, 'copy');
					copyButton.style.background = 'var(--interactive-normal)';
				}, 2000);
			} catch (error) {
				new Notice('Failed to copy to clipboard');
				Debug.error('Failed to copy to clipboard:', error);
			}
		});
	}

	private async checkPortAvailability(port: number, setting: Setting): Promise<void> {
		if (!this.plugin.settings.autoDetectPortConflicts) return;
		
		const status = await this.plugin.checkPortConflict(port);
		
		switch (status) {
			case 'available':
				setting.setDesc(`Port for HTTP MCP server (default: 3001) ✅ Available`);
				break;
			case 'this-server':
				setting.setDesc(`Port for HTTP MCP server (default: 3001) 🟢 This server`);
				break;
			case 'in-use':
				setting.setDesc(`Port for HTTP MCP server (default: 3001) ⚠️ Port ${port} in use`);
				break;
			default:
				setting.setDesc('Port for HTTP MCP server (default: 3001)');
		}
	}
	
	private async checkHttpsPortAvailability(port: number, setting: Setting): Promise<void> {
		if (!this.plugin.settings.autoDetectPortConflicts) return;
		
		const status = await this.plugin.checkPortConflict(port);
		
		switch (status) {
			case 'available':
				setting.setDesc(`Port for HTTPS MCP server (default: 3443) ✅ Available`);
				break;
			case 'this-server':
				setting.setDesc(`Port for HTTPS MCP server (default: 3443) 🟢 This server`);
				break;
			case 'in-use':
				setting.setDesc(`Port for HTTPS MCP server (default: 3443) ⚠️ Port ${port} in use`);
				break;
			default:
				setting.setDesc('Port for HTTPS MCP server (default: 3443)');
		}
	}

	refreshConnectionStatus(): void {
		// Simply refresh the entire settings display to ensure accurate data
		// This is more reliable than trying to manually update DOM elements
		this.display();
	}

	private updatePortApplyButton(setting: Setting, hasChanges: boolean, pendingPort: number): void {
		const button = setting.components.find(c => (c as any).buttonEl) as any;
		if (button) {
			if (hasChanges) {
				button.buttonEl.classList.remove('mcp-hidden');
				setting.setDesc(`Port for HTTP MCP server (default: 3001) - Click Apply to change to ${pendingPort}`);
			} else {
				button.buttonEl.classList.add('mcp-hidden');
				setting.setDesc('Port for HTTP MCP server (default: 3001)');
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
}