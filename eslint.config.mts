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
	{
		files: ["**/*.ts"],
		rules: {
			// Enable auto-fix for sentence case UI text
			"obsidianmd/ui/sentence-case": ["error", { allowAutoFix: true }],
		},
	},
	// MCP SDK's Server class is deprecated in favor of McpServer, but McpServer
	// requires Zod schemas for tool registration. This codebase uses raw JSON Schema
	// with setRequestHandler, which is only available on the deprecated Server class.
	{
		files: ["src/mcp-server.ts", "src/utils/mcp-server-pool.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
		},
	},
	// builtin-modules is build-tooling only (esbuild.config.mjs), not plugin code.
	// js-yaml is used for YAML parsing in Bases API — no built-in alternative exists.
	//
	// obsidianmd >= 0.3.0 wires its typed plugin rules into the hybrid recommended
	// config without a `**/*.ts` files scope, so ESLint also tries to run them on
	// package.json (which uses the JSON language and has no parser services). The
	// rules call getParserServices() and abort the whole run. Disable the typed
	// rules here for the JSON files the recommended config inspects.
	{
		files: ["package.json", "**/*.json"],
		rules: {
			"depend/ban-dependencies": "off",
			"obsidianmd/no-plugin-as-component": "off",
			"obsidianmd/no-view-references-in-plugin": "off",
			"obsidianmd/no-unsupported-api": "off",
			"obsidianmd/prefer-file-manager-trash-file": "off",
			"obsidianmd/prefer-instanceof": "off",
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
		"mcpb",
		"scripts",
		// Data files — obsidianmd's recommended config only wires the JSON
		// language to package.json; other .json files fall through to the JS
		// parser and fail with "Unexpected token :". They aren't code anyway.
		// (The validate-manifest rule reads manifest.json directly via fs.)
		"tsconfig.json",
		"package-lock.json",
		"manifest.json",
		"versions.json",
		".claude/**",
		"src/config/**/*.json",
	]),
);
