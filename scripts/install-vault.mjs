// Copies the built plugin into an Obsidian vault for development.
// Usage: node scripts/install-vault.mjs [--vault <path>] [--sample <file.pur>]
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_VAULT = "C:\OldBackUp\My Programming Stuff\the-slop-engine\cache\uploads\PUREREF-INTEGRATION";
const PLUGIN_ID = "pureref-viewer";
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const vault = path.resolve(argValue("--vault") ?? DEFAULT_VAULT);
const sample = path.resolve(argValue("--sample") ?? path.join(repoRoot, "UI Explorations.pur"));

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

if (!(await exists(path.join(vault, ".obsidian")))) {
	console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}
for (const name of ARTIFACTS) {
	if (!(await exists(path.join(repoRoot, name)))) {
		console.error(`Missing ${name} in ${repoRoot}. Run \`npm run build\` first.`);
		process.exit(1);
	}
}

const pluginDir = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);
await mkdir(pluginDir, { recursive: true });
for (const name of ARTIFACTS) {
	await copyFile(path.join(repoRoot, name), path.join(pluginDir, name));
	console.log(`copied ${name} -> ${pluginDir}`);
}
// Marker for the community "Hot Reload" plugin (pjeby/hot-reload).
await writeFile(path.join(pluginDir, ".hotreload"), "");

if (await exists(sample)) {
	const target = path.join(vault, path.basename(sample));
	if (!(await exists(target))) {
		await copyFile(sample, target);
		console.log(`copied sample board -> ${target}`);
	}
}
console.log("Done. Enable the plugin under Settings -> Community plugins (reload Obsidian if it does not appear).");
