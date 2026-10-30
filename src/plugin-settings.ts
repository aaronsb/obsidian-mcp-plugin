/**
 * The plugin's persisted settings: their shape, their defaults, and how a
 * data.json from disk becomes a settings object.
 *
 * Kept apart from main.ts so loading can be tested without the Obsidian UI.
 */
import type { CertificateConfig } from './utils/certificate-manager';
import type { ValidationConfig } from './validation/input-validator';
import type { BindMode } from './utils/network-classifier';
import { normalizeAllowlist } from './utils/obsidian-commands';

export interface MCPPluginSettings {
	httpEnabled: boolean;
	httpPort: number;
	httpsEnabled: boolean;
	httpsPort: number;
	certificateConfig: CertificateConfig;
	// ADR-107: network exposure modes
	bindMode: BindMode;
	customBindHost: string;
	hasShownBindMigrationNotice: boolean;
	debugLogging: boolean;
	showConnectionStatus: boolean;
	autoDetectPortConflicts: boolean;
	apiKey: string;
	dangerouslyDisableAuth: boolean;
	readOnlyMode: boolean;
	enableWebFetch: boolean;
	pathExclusionsEnabled: boolean;
	enableIgnoreContextMenu: boolean;
	validation?: Partial<ValidationConfig>;
	toolVisibility: Record<string, boolean>;
	// ADR-204: exact command ids system.execute may run. Empty refuses every command.
	commandExecutionAllowlist: string[];
	notifyOnCommandExecution: boolean;
}

export const DEFAULT_SETTINGS: MCPPluginSettings = {
	httpEnabled: true, // Start enabled by default
	httpPort: 3001,
	httpsEnabled: false, // HTTPS disabled by default
	httpsPort: 3443,
	certificateConfig: {
		enabled: false,
		selfSigned: true,
		autoGenerate: true,
		// rejectUnauthorized omitted on purpose: inert for our inbound HTTPS
		// server (no requestCert); cert-manager defaults it to true. See #163.
		minTLSVersion: 'TLSv1.2'
	},
	bindMode: 'loopback',
	customBindHost: '',
	hasShownBindMigrationNotice: false,
	debugLogging: false,
	showConnectionStatus: true,
	autoDetectPortConflicts: true,
	apiKey: '', // Will be generated on first load
	dangerouslyDisableAuth: false, // Auth enabled by default
	readOnlyMode: false, // Read-only mode disabled by default
	enableWebFetch: false, // ADR-109: outbound web fetch off by default, for everyone
	pathExclusionsEnabled: false, // Path exclusions disabled by default
	enableIgnoreContextMenu: false, // Context menu disabled by default
	validation: {
		maxFileSize: 10 * 1024 * 1024, // 10MB default
		maxBatchSize: 100,
		maxPathLength: 255,
		maxRegexComplexity: 100,
		strictMode: false
	},
	toolVisibility: {}, // Empty = all tools enabled, except opt-in actions (system.execute)
	commandExecutionAllowlist: [], // ADR-204: no command may run until the user lists it
	notifyOnCommandExecution: true
};

/**
 * Build the settings object from what loadData() returned.
 *
 * Coerces the security values, because data.json is hand-editable. The
 * security predicate tests `=== true` while a toggle renders with
 * truthiness, so a string "true" would show read-only ON while it was not
 * enforced. Normalising here means UI and enforcement read one value.
 *
 * Shares no object with DEFAULT_SETTINGS. The merge is shallow, so a key
 * missing from data.json used to leave the default's own object in the
 * settings; the UI mutates toolVisibility in place, so turning system.execute
 * on wrote into DEFAULT_SETTINGS and every later load started opted in.
 */
export function mergeLoadedSettings(loaded: Partial<MCPPluginSettings> | null): MCPPluginSettings {
	const settings: MCPPluginSettings = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded ?? {});

	const visibility: unknown = settings.toolVisibility;
	settings.toolVisibility = visibility !== null && typeof visibility === 'object' && !Array.isArray(visibility)
		? { ...(visibility as Record<string, boolean>) }
		: {};

	settings.readOnlyMode = settings.readOnlyMode === true;
	settings.dangerouslyDisableAuth = settings.dangerouslyDisableAuth === true;
	settings.enableWebFetch = settings.enableWebFetch === true;
	// ADR-204. A fresh array also keeps edits off the DEFAULT_SETTINGS one.
	settings.commandExecutionAllowlist = normalizeAllowlist(settings.commandExecutionAllowlist);
	settings.notifyOnCommandExecution = settings.notifyOnCommandExecution !== false;

	return settings;
}
