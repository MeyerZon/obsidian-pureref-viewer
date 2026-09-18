import { PluginSettingTab, Setting, type App } from "obsidian";
import type PureRefPlugin from "./main.ts";

export type InitialView = "fit" | "actual" | "saved";
export type BoardBackground = "pureref" | "theme";

export interface PureRefSettings {
	/** Height in pixels of boards embedded in notes. */
	embedHeight: number;
	initialView: InitialView;
	showNotes: boolean;
	showDrawings: boolean;
	background: BoardBackground;
	/** Folder name for exported images, relative to the board's folder. `{{board}}` = board name. */
	exportFolderTemplate: string;
}

export const DEFAULT_SETTINGS: PureRefSettings = {
	embedHeight: 400,
	initialView: "fit",
	showNotes: true,
	showDrawings: true,
	background: "pureref",
	exportFolderTemplate: "{{board}} images",
};

export function sanitizeSettings(raw: unknown): PureRefSettings {
	const s = { ...DEFAULT_SETTINGS };
	if (!raw || typeof raw !== "object") return s;
	const r = raw as Record<string, unknown>;
	if (typeof r.embedHeight === "number" && Number.isFinite(r.embedHeight)) {
		s.embedHeight = clampHeight(r.embedHeight);
	}
	if (r.initialView === "fit" || r.initialView === "actual" || r.initialView === "saved") s.initialView = r.initialView;
	if (typeof r.showNotes === "boolean") s.showNotes = r.showNotes;
	if (typeof r.showDrawings === "boolean") s.showDrawings = r.showDrawings;
	if (r.background === "pureref" || r.background === "theme") s.background = r.background;
	if (typeof r.exportFolderTemplate === "string" && r.exportFolderTemplate.trim() !== "") {
		s.exportFolderTemplate = r.exportFolderTemplate.trim();
	}
	return s;
}

export function clampHeight(h: number): number {
	return Math.min(4000, Math.max(100, Math.round(h)));
}

export class PureRefSettingTab extends PluginSettingTab {
	private readonly plugin: PureRefPlugin;

	constructor(app: App, plugin: PureRefPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl).setName("Board view").setHeading();

		new Setting(containerEl)
			.setName("Initial view")
			.setDesc("How a board is framed when it is opened.")
			.addDropdown((d) =>
				d
					.addOptions({
						fit: "Fit the whole board",
						actual: "Actual size (100%)",
						saved: "Zoom level saved by PureRef",
					})
					.setValue(settings.initialView)
					.onChange(async (value) => {
						settings.initialView = value as InitialView;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Background")
			.setDesc("Canvas colour behind the board.")
			.addDropdown((d) =>
				d
					.addOptions({ pureref: "PureRef dark grey", theme: "Match the Obsidian theme" })
					.setValue(settings.background)
					.onChange(async (value) => {
						settings.background = value as BoardBackground;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show notes")
			.setDesc("Render text notes placed on the board.")
			.addToggle((t) =>
				t.setValue(settings.showNotes).onChange(async (value) => {
					settings.showNotes = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show drawings")
			.setDesc("Render pen strokes drawn on the board.")
			.addToggle((t) =>
				t.setValue(settings.showDrawings).onChange(async (value) => {
					settings.showDrawings = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Embeds").setHeading();

		new Setting(containerEl)
			.setName("Embed height")
			.setDesc("Height in pixels of boards embedded in notes. Override per embed with ![[board.pur#height=300]].")
			.addText((t) =>
				t
					.setPlaceholder(String(DEFAULT_SETTINGS.embedHeight))
					.setValue(String(settings.embedHeight))
					.onChange(async (value) => {
						const n = Number(value);
						if (!Number.isFinite(n) || n <= 0) return;
						settings.embedHeight = clampHeight(n);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Export").setHeading();

		new Setting(containerEl)
			.setName("Export folder")
			.setDesc("Folder for exported images, created next to the board. {{board}} is replaced by the board's name.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.exportFolderTemplate)
					.setValue(settings.exportFolderTemplate)
					.onChange(async (value) => {
						settings.exportFolderTemplate = value.trim() || DEFAULT_SETTINGS.exportFolderTemplate;
						await this.plugin.saveSettings();
					}),
			);
	}
}
