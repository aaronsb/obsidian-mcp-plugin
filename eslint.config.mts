import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Node.js globals needed for desktop-only plugin (isDesktopOnly: true)
				require: "readonly",
				process: "readonly",
				Buffer: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
				module: "readonly",
				exports: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Disable strict `any` type rules for now.
	// This codebase has many dynamic MCP protocol handlers and Obsidian API
	// interactions that use `any`. Enabling these rules would require significant
	// refactoring. Focus first on Obsidian-specific rules and actual bugs.
	// TODO: Gradually enable stricter type checking as the codebase matures.
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			// Unused vars are warnings, not errors - keep for cleanup later
			"@typescript-eslint/no-unused-vars": "warn",
			// Enable auto-fix for sentence case UI text
			"obsidianmd/ui/sentence-case": ["error", { allowAutoFix: true }],
			// This is a desktop-only plugin (isDesktopOnly: true in manifest.json).
			// Node.js require() is intentionally used for dynamic imports of optional
			// Node.js modules like 'net' and 'https' that are only available at runtime.
			"@typescript-eslint/no-require-imports": "off",
			// Confirm dialogs are used for destructive operations (certificate regeneration).
			// TODO: Replace with Obsidian's Modal API for better UX.
			"no-alert": "warn",
			// These dependencies are intentionally used and appropriate for this plugin:
			// - dotenv: for development configuration
			// - js-yaml: for YAML parsing (used by MCP protocol)
			// - builtin-modules: build-time only, used by esbuild config
			"depend/ban-dependencies": "off",
		},
	},
	// Disable depend/ban-dependencies for package.json
	{
		files: ["package.json"],
		rules: {
			"depend/ban-dependencies": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"tests",
		"test-*.js",
		"*.config.js",
		"*.config.mjs",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"sync-version.mjs",
		"build-worker.js",
		"version-bump.mjs",
		"jest.config.js",
		"versions.json",
		"main.js",
		"worker.js",
	]),
);
