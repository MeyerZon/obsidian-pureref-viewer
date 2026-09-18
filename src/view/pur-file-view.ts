import { FileView, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type PureRefPlugin from "../main.ts";
import type { Board } from "../pur/model.ts";
import { parsePur } from "../pur/parser.ts";
import { canOpenExternally, openInDefaultApp } from "../util/open-external.ts";
import { BoardRenderer } from "./board-renderer.ts";
import { isPanZoomState, type PanZoomState } from "./panzoom.ts";

export const VIEW_TYPE_PUREREF = "pureref-board";

export class PurFileView extends FileView {
	override allowNoFile = false;
	override navigation = true;
	private readonly plugin: PureRefPlugin;
	private hostEl: HTMLElement | null = null;
	private renderer: BoardRenderer | null = null;
	private board: Board | null = null;
	private pendingState: PanZoomState | null = null;
	private loadToken = 0;

	constructor(leaf: WorkspaceLeaf, plugin: PureRefPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PUREREF;
	}

	override getIcon(): string {
		return "image";
	}

	override getDisplayText(): string {
		return this.file?.basename ?? "PureRef board";
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === "pur";
	}

	getBoard(): Board | null {
		return this.board;
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen();
		this.contentEl.addClass("pureref-view-content");
		this.hostEl = this.contentEl.createDiv({ cls: "pureref-host" });

		this.addAction("maximize", "Fit board to view", () => this.renderer?.fitAll(true));
		this.addAction("scan", "Zoom to actual size", () => this.renderer?.zoomActual(true));
		if (canOpenExternally(this.app)) {
			this.addAction("external-link", "Open in PureRef", () => {
				if (this.file) void openInDefaultApp(this.app, this.file.path);
			});
		}

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.file && file.path === this.file.path) void this.reload();
			}),
		);
	}

	override async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		this.clearBoard();
		let buffer: ArrayBuffer;
		try {
			buffer = await this.app.vault.readBinary(file);
		} catch (e) {
			if (token === this.loadToken) this.showError(e, file);
			return;
		}
		if (token !== this.loadToken || this.file !== file) return;
		let board: Board;
		try {
			board = parsePur(buffer);
		} catch (e) {
			this.showError(e, file);
			return;
		}
		this.board = board;
		if (!this.hostEl) return;
		const s = this.plugin.settings;
		this.renderer = new BoardRenderer(this.hostEl, board, {
			showNotes: s.showNotes,
			showDrawings: s.showDrawings,
			background: s.background,
			initialView: s.initialView,
			wheelRequiresModifier: false,
			initialState: this.pendingState,
			onViewChange: () => this.app.workspace.requestSaveLayout(),
		});
		this.pendingState = null;
		this.addChild(this.renderer);
	}

	override async onUnloadFile(_file: TFile): Promise<void> {
		this.loadToken++;
		this.clearBoard();
	}

	protected override async onClose(): Promise<void> {
		this.loadToken++;
		this.clearBoard();
		await super.onClose();
	}

	override onResize(): void {
		this.renderer?.ensureInitialView();
	}

	override getState(): Record<string, unknown> {
		const state = super.getState();
		if (this.renderer?.panzoom) state.panzoom = this.renderer.panzoom.getState();
		return state;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const pz = state && typeof state === "object" ? (state as Record<string, unknown>).panzoom : undefined;
		this.pendingState = isPanZoomState(pz) ? pz : null;
		await super.setState(state, result);
	}

	async reload(): Promise<void> {
		if (!this.file) return;
		// Keep the current view when re-rendering the same file.
		this.pendingState = this.renderer?.panzoom.getState() ?? null;
		await this.onLoadFile(this.file);
	}

	fitAll(): void {
		this.renderer?.fitAll(true);
	}

	zoomActual(): void {
		this.renderer?.zoomActual(true);
	}

	zoomBy(factor: number): void {
		this.renderer?.zoomBy(factor);
	}

	private clearBoard(): void {
		if (this.renderer) {
			this.removeChild(this.renderer);
			this.renderer = null;
		}
		this.board = null;
		this.hostEl?.empty();
	}

	private showError(error: unknown, file: TFile): void {
		if (!this.hostEl) return;
		this.hostEl.empty();
		const message = error instanceof Error ? error.message : String(error);
		const panel = this.hostEl.createDiv({ cls: "pureref-error" });
		panel.createDiv({ cls: "pureref-error-title", text: `Could not open ${file.name}` });
		panel.createDiv({ cls: "pureref-error-message", text: message });
		if (canOpenExternally(this.app)) {
			const button = panel.createEl("button", { cls: "mod-cta", text: "Open in PureRef" });
			this.registerDomEvent(button, "click", () => void openInDefaultApp(this.app, file.path));
		}
	}
}
