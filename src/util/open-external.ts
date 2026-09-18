import { Notice, Platform, type App } from "obsidian";
import "../types/obsidian-internal.ts";

/** True when the running Obsidian can hand a file to the OS default application. */
export function canOpenExternally(app: App): boolean {
	return Platform.isDesktopApp && typeof app.openWithDefaultApp === "function";
}

export function canRevealInFolder(app: App): boolean {
	return Platform.isDesktopApp && typeof app.showInFolder === "function";
}

/** Opens a vault-relative path with the default application (PureRef for `.pur`). */
export async function openInDefaultApp(app: App, path: string): Promise<void> {
	if (!canOpenExternally(app)) {
		new Notice("Opening files in PureRef is only available in the desktop app.");
		return;
	}
	try {
		await app.openWithDefaultApp?.(path);
	} catch (e) {
		new Notice(`Could not open the file: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export async function revealInFolder(app: App, path: string): Promise<void> {
	if (!canRevealInFolder(app)) {
		new Notice("Revealing files is only available in the desktop app.");
		return;
	}
	try {
		await app.showInFolder?.(path);
	} catch (e) {
		new Notice(`Could not reveal the file: ${e instanceof Error ? e.message : String(e)}`);
	}
}
