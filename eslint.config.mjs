import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "scripts/**", "esbuild.config.mjs", "test/**"] },
	// Bundles eslint:recommended and typescript-eslint's recommended type-checked rules.
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["PureRef", "Obsidian"] }],
			// The declarative settings API needs Obsidian 1.13; this plugin supports 1.7.2+.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);
