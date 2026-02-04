import { App, PluginManifest } from 'obsidian';

/**
 * Internal Obsidian plugin instance with manifest and optional API
 */
interface ObsidianPluginInstance {
  manifest: PluginManifest;
  api?: unknown;
}

/**
 * Internal Obsidian community plugins manager (not in public type defs)
 */
interface ObsidianPluginsInternal {
  enabledPlugins: Set<string>;
  manifests: Record<string, PluginManifest>;
  plugins: Record<string, ObsidianPluginInstance>;
}

/**
 * Extended App interface exposing internal plugins manager
 */
interface AppWithPlugins extends App {
  plugins: ObsidianPluginsInternal;
}

/**
 * Utility for detecting and checking the status of Obsidian community plugins
 */
export class PluginDetector {
  constructor(private app: App) {}

  /**
   * Access the internal plugins manager via a typed cast
   */
  private getPluginsInternal(): ObsidianPluginsInternal | undefined {
    return (this.app as unknown as AppWithPlugins).plugins;
  }

  /**
   * Check if a plugin is installed and enabled
   */
  isPluginEnabled(pluginId: string): boolean {
    // Check if plugin is loaded and enabled
    const plugins = this.getPluginsInternal();
    return plugins?.enabledPlugins?.has(pluginId) ?? false;
  }

  /**
   * Check if a plugin is installed (but may not be enabled)
   */
  isPluginInstalled(pluginId: string): boolean {
    const plugins = this.getPluginsInternal();
    return Object.prototype.hasOwnProperty.call(plugins?.manifests ?? {}, pluginId);
  }

  /**
   * Get plugin instance if available
   */
  getPlugin(pluginId: string): ObsidianPluginInstance | null {
    if (!this.isPluginEnabled(pluginId)) {
      return null;
    }
    const plugins = this.getPluginsInternal();
    return plugins?.plugins?.[pluginId] ?? null;
  }

  /**
   * Check if Dataview plugin is available
   */
  isDataviewAvailable(): boolean {
    return this.isPluginEnabled('dataview');
  }

  /**
   * Get Dataview plugin instance
   */
  getDataviewPlugin(): ObsidianPluginInstance | null {
    return this.getPlugin('dataview');
  }

  /**
   * Check if Dataview API is accessible
   */
  isDataviewAPIReady(): boolean {
    const dataview = this.getDataviewPlugin();
    if (!dataview) return false;

    // Check if the Dataview API is available
    return dataview.api !== null && dataview.api !== undefined;
  }

  /**
   * Get Dataview API instance
   */
  getDataviewAPI(): unknown {
    const dataview = this.getDataviewPlugin();
    return dataview?.api ?? null;
  }

  /**
   * Get information about Dataview plugin status
   */
  getDataviewStatus(): {
    installed: boolean;
    enabled: boolean;
    apiReady: boolean;
    version?: string;
  } {
    const installed = this.isPluginInstalled('dataview');
    const enabled = this.isPluginEnabled('dataview');
    const apiReady = this.isDataviewAPIReady();

    const plugin = this.getDataviewPlugin();
    const version: string | undefined = plugin?.manifest?.version;

    return {
      installed,
      enabled,
      apiReady,
      version
    };
  }
}