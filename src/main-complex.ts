import { Debug } from './utils/debug';
import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { MCPHttpServer } from './mcp-server';

interface MCPPluginSettings {
	httpEnabled: boolean;
	httpPort: number;
	httpsPort: number;
	enableSSL: boolean;
	debugLogging: boolean;
}

const DEFAULT_SETTINGS: MCPPluginSettings = {
	httpEnabled: true,
	httpPort: 3001,
	httpsPort: 3002,
	enableSSL: false,
	debugLogging: false
};

export default class ObsidianMCPPlugin extends Plugin {
	settings!: MCPPluginSettings;
	private mcpServer?: MCPHttpServer;

	async onload() {
		await this.loadSettings();

		Debug.log('Loading Obsidian MCP Plugin v0.1.2');

		// Add settings tab
		this.addSettingTab(new MCPSettingTab(this.app, this));

		// Add command to restart server
		this.addCommand({
			id: 'restart-mcp-server',
			name: 'Restart MCP Server',
			callback: () => {
				Debug.log('MCP Server restart requested');
				// TODO: Implement server restart
			}
		});

		// Start MCP server if enabled
		if (this.settings.httpEnabled) {
			await this.startMCPServer();
		}

		// Add status bar item
		this.updateStatusBar();

		Debug.log('Obsidian MCP Plugin loaded successfully');
	}

	async onunload() {
		Debug.log('Unloading Obsidian MCP Plugin');
		await this.stopMCPServer();
	}

	private async startMCPServer(): Promise<void> {
		try {
			this.mcpServer = new MCPHttpServer(this.app, this.settings.httpPort);
			await this.mcpServer.start();
			this.updateStatusBar();
		} catch (error) {
			Debug.error('Failed to start MCP server:', error);
			this.updateStatusBar();
		}
	}

	private async stopMCPServer(): Promise<void> {
		if (this.mcpServer) {
			await this.mcpServer.stop();
			this.mcpServer = undefined;
			this.updateStatusBar();
		}
	}

	private updateStatusBar(): void {
		const statusBarItemEl = this.addStatusBarItem();
		
		if (!this.settings.httpEnabled) {
			statusBarItemEl.setText('MCP: Disabled');
		} else if (this.mcpServer?.isServerRunning()) {
			statusBarItemEl.setText(`MCP: :${this.settings.httpPort}`);
		} else {
			statusBarItemEl.setText('MCP: Error');
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		containerEl.createEl('h2', {text: 'Obsidian MCP Plugin Settings'});

		new Setting(containerEl)
			.setName('Enable HTTP Server')
			.setDesc('Enable the HTTP server for REST API and MCP access')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.httpEnabled)
				.onChange(async (value) => {
					this.plugin.settings.httpEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('HTTP Port')
			.setDesc('Port for HTTP MCP server (default: 3001)')
			.addText(text => text
				.setPlaceholder('3001')
				.setValue(this.plugin.settings.httpPort.toString())
				.onChange(async (value) => {
					const port = parseInt(value);
					if (!isNaN(port) && port > 0 && port < 65536) {
						this.plugin.settings.httpPort = port;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('HTTPS Port')
			.setDesc('Port for HTTPS MCP server (default: 3002)')
			.addText(text => text
				.setPlaceholder('3002')
				.setValue(this.plugin.settings.httpsPort.toString())
				.onChange(async (value) => {
					const port = parseInt(value);
					if (!isNaN(port) && port > 0 && port < 65536) {
						this.plugin.settings.httpsPort = port;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Enable SSL')
			.setDesc('Enable HTTPS with self-signed certificate')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableSSL)
				.onChange(async (value) => {
					this.plugin.settings.enableSSL = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug Logging')
			.setDesc('Enable detailed debug logging')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}));
	}
}