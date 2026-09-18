import { Notice, Plugin, TFile, type Menu } from "obsidian";
import { exportBoardImages } from "./commands/export-images.ts";
import { DEFAULT_SETTINGS, PureRefSettingTab, sanitizeSettings, type PureRefSettings } from "./settings.ts";
import { canOpenExternally, canRevealInFolder, openInDefaultApp, revealInFolder } from "./util/open-external.ts";
import { PurFileView, VIEW_TYPE_PUREREF } from "./view/pur-file-view.ts";
import { registerPurEmbeds } from "./view/pur-embed.ts";

export default class PureRefPlugin extends Plugin {
	override settings: PureRefSettings = { ...DEFAULT_SETTINGS };

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PUREREF, (leaf) => new PurFileView(leaf, this));
		try {
			this.registerExtensions(["pur"], VIEW_TYPE_PUREREF);
		} catch {
			new Notice("PureRef Viewer: another plugin already handles .pur files.");
		}
		registerPurEmbeds(this);
		this.registerCommands();
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "pur") this.addFileMenuItems(menu, file);
			}),
		);
		this.addSettingTab(new PureRefSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshViews();
	}

	/** Re-renders every open board so new settings take effect. */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PUREREF)) {
			if (leaf.view instanceof PurFileView) void leaf.view.reload();
		}
	}

	private activeBoardView(): PurFileView | null {
		return this.app.workspace.getActiveViewOfType(PurFileView);
	}

	private activePurFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "pur" ? file : null;
	}

	private registerCommands(): void {
		const viewCommand = (id: string, name: string, run: (view: PurFileView) => void): void => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const view = this.activeBoardView();
					if (!view) return false;
					if (!checking) run(view);
					return true;
				},
			});
		};
		viewCommand("fit-to-view", "Fit board to view", (v) => v.fitAll());
		viewCommand("zoom-actual", "Zoom board to actual size", (v) => v.zoomActual());
		viewCommand("zoom-in", "Zoom in on board", (v) => v.zoomBy(1.25));
		viewCommand("zoom-out", "Zoom out of board", (v) => v.zoomBy(0.8));

		this.addCommand({
			id: "export-images",
			name: "Export board images to the vault",
			checkCallback: (checking) => {
				const file = this.activePurFile();
				if (!file) return false;
				if (!checking) {
					void exportBoardImages(this.app, file, this.settings.exportFolderTemplate, this.activeBoardView()?.getBoard());
				}
				return true;
			},
		});
		this.addCommand({
			id: "open-in-pureref",
			name: "Open board in PureRef",
			checkCallback: (checking) => {
				const file = this.activePurFile();
				if (!file || !canOpenExternally(this.app)) return false;
				if (!checking) void openInDefaultApp(this.app, file.path);
				return true;
			},
		});
	}

	private addFileMenuItems(menu: Menu, file: TFile): void {
		if (canOpenExternally(this.app)) {
			menu.addItem((item) =>
				item
					.setTitle("Open in PureRef")
					.setIcon("external-link")
					.onClick(() => void openInDefaultApp(this.app, file.path)),
			);
		}
		if (canRevealInFolder(this.app)) {
			menu.addItem((item) =>
				item
					.setTitle("Reveal board in folder")
					.setIcon("folder-open")
					.onClick(() => void revealInFolder(this.app, file.path)),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Export board images")
				.setIcon("images")
				.onClick(() => void exportBoardImages(this.app, file, this.settings.exportFolderTemplate)),
		);
	}
}
