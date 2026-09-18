/**
 * Hand-declared shapes of undocumented Obsidian APIs used by this plugin.
 * Everything here is feature-detected at runtime; nothing may be assumed to exist.
 */
import type { App, Component, TFile } from "obsidian";

export interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext?: string;
	sourcePath?: string;
	depth?: number;
	showInline?: boolean;
	displayMode?: boolean;
}

export interface EmbedComponent extends Component {
	loadFile(): Promise<void> | void;
}

export type EmbedCreator = (ctx: EmbedContext, file: TFile, subpath?: string) => EmbedComponent;

export interface EmbedRegistry {
	registerExtensions(extensions: string[], creator: EmbedCreator): void;
	unregisterExtensions(extensions: string[]): void;
	registerExtension?(extension: string, creator: EmbedCreator): void;
	unregisterExtension?(extension: string): void;
	isExtensionRegistered?(extension: string): boolean;
	embedByExtension?: Record<string, EmbedCreator>;
}

declare module "obsidian" {
	interface App {
		embedRegistry?: EmbedRegistry;
		/** Opens a vault-relative path with the operating system's default application. */
		openWithDefaultApp?(path: string): Promise<void> | void;
		/** Reveals a vault-relative path in the system file manager. */
		showInFolder?(path: string): Promise<void> | void;
	}
}
