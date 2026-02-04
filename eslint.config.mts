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
	// builtin-modules is build-tooling only (esbuild.config.mjs), not plugin code.
	// js-yaml is used for YAML parsing in Bases API — no built-in alternative exists.
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
