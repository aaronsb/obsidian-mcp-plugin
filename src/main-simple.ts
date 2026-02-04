import { Debug } from './utils/debug';
import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface MCPPluginSettings {
	httpEnabled: boolean;
	httpPort: number;
	httpsPort: number;
	enableSSL: boolean;
	debugLogging: boolean;
}

const DEFAULT_SETTINGS: MCPPluginSettings = {
	httpEnabled: false, // Start disabled to avoid server startup issues
	httpPort: 3001,
	httpsPort: 3002,
	enableSSL: false,
	debugLogging: false
};

export default class ObsidianMCPPlugin extends Plugin {
	settings!: MCPPluginSettings;

	async onload() {
		Debug.log('🚀 Starting Obsidian MCP Plugin v0.1.2');
		
		try {
			await this.loadSettings();
			Debug.log('✅ Settings loaded');

			// Add settings tab
			this.addSettingTab(new MCPSettingTab(this.app, this));
			Debug.log('✅ Settings tab added');

			// Add command
			this.addCommand({
				id: 'restart-mcp-server',
				name: 'Restart mcp server',
				callback: () => {
					Debug.log('MCP Server restart requested');
				}
			});
			Debug.log('✅ Command added');

			// Add status bar item
			const statusBarItemEl = this.addStatusBarItem();
			if (this.settings.httpEnabled) {
				statusBarItemEl.setText(`MCP: :${this.settings.httpPort}`);
			} else {
				statusBarItemEl.setText('Mcp: disabled');
			}
			Debug.log('✅ Status bar added');

			Debug.log('🎉 Obsidian MCP Plugin loaded successfully');
		} catch (error) {
			Debug.error('❌ Error loading Obsidian MCP Plugin:', error);
			throw error; // Re-throw to show in Obsidian's plugin list
		}
	}

	onunload() {
		Debug.log('👋 Unloading Obsidian MCP Plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MCPPluginSettings>);
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

		new Setting(containerEl).setName("Plugin configuration").setHeading();

		new Setting(containerEl)
			.setName('Enable HTTP server')
			.setDesc('Enable the HTTP server for mcp access (requires restart)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.httpEnabled)
				.onChange(async (value) => {
					this.plugin.settings.httpEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Server port')
			.setDesc('Port for the server (default: 3001)')
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
			.setName('Debug logging')
			.setDesc('Enable detailed debug logging in console')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}));
	}
}