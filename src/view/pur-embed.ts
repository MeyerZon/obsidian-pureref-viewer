import { MarkdownRenderChild, TFile, setIcon, type MarkdownPostProcessorContext } from "obsidian";
import type PureRefPlugin from "../main.ts";
import { parsePur } from "../pur/parser.ts";
import { clampHeight } from "../settings.ts";
import type { EmbedContext, EmbedRegistry } from "../types/obsidian-internal.ts";
import { BoardRenderer } from "./board-renderer.ts";

/** Parses `height=300&fit=1` style parameters from an embed subpath. */
function parseEmbedParams(subpath: string | undefined): URLSearchParams {
	if (!subpath) return new URLSearchParams();
	const s = subpath.startsWith("#") ? subpath.slice(1) : subpath;
	try {
		return new URLSearchParams(s);
	} catch {
		return new URLSearchParams();
	}
}

/**
 * Inline board rendered inside a note (`![[board.pur]]`). Used both through Obsidian's embed
 * registry and through the markdown post-processor fallback.
 */
export class PurEmbed extends MarkdownRenderChild {
	private readonly plugin: PureRefPlugin;
	private readonly file: TFile;
	private readonly params: URLSearchParams;
	private renderer: BoardRenderer | null = null;
	private loading: Promise<void> | null = null;

	constructor(plugin: PureRefPlugin, file: TFile, containerEl: HTMLElement, subpath?: string) {
		super(containerEl);
		this.plugin = plugin;
		this.file = file;
		this.params = parseEmbedParams(subpath);
	}

	/** Called by Obsidian (embed registry) or by the post-processor fallback. */
	loadFile(): Promise<void> {
		if (!this.loading) this.loading = this.render();
		return this.loading;
	}

	override onunload(): void {
		this.clear();
	}

	private clear(): void {
		if (this.renderer) {
			this.removeChild(this.renderer);
			this.renderer = null;
		}
		this.containerEl.empty();
	}

	private async render(): Promise<void> {
		const { containerEl, plugin, file } = this;
		this.clear();
		containerEl.addClass("pureref-embed");
		const heightParam = Number(this.params.get("height"));
		const height = Number.isFinite(heightParam) && heightParam > 0 ? clampHeight(heightParam) : plugin.settings.embedHeight;
		containerEl.setCssProps({ "--pureref-embed-height": `${height}px` });

		let buffer: ArrayBuffer;
		try {
			buffer = await plugin.app.vault.readBinary(file);
		} catch (e) {
			this.showError(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		let board;
		try {
			board = parsePur(buffer);
		} catch (e) {
			this.showError(e instanceof Error ? e.message : String(e));
			return;
		}
		containerEl.empty();
		const host = containerEl.createDiv({ cls: "pureref-host" });
		const s = plugin.settings;
		this.renderer = new BoardRenderer(host, board, {
			showNotes: s.showNotes,
			showDrawings: s.showDrawings,
			background: s.background,
			initialView: this.params.get("view") === "actual" ? "actual" : "fit",
			wheelRequiresModifier: true,
		});
		this.addChild(this.renderer);

		const toolbar = containerEl.createDiv({ cls: "pureref-embed-toolbar" });
		this.toolbarButton(toolbar, "maximize", "Fit board", () => this.renderer?.fitAll(true));
		this.toolbarButton(toolbar, "zoom-in", "Zoom in (Ctrl+wheel also zooms)", () => this.renderer?.zoomBy(1.25));
		this.toolbarButton(toolbar, "zoom-out", "Zoom out", () => this.renderer?.zoomBy(0.8));
		this.toolbarButton(toolbar, "square-arrow-out-up-right", "Open board in a new tab", () => {
			void plugin.app.workspace.getLeaf("tab").openFile(file);
		});
		containerEl.createDiv({ cls: "pureref-embed-caption", text: file.basename });
	}

	private toolbarButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", {
			cls: "pureref-embed-btn clickable-icon",
			attr: { "aria-label": label, type: "button" },
		});
		setIcon(button, icon);
		this.registerDomEvent(button, "click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
	}

	private showError(message: string): void {
		this.containerEl.empty();
		const panel = this.containerEl.createDiv({ cls: "pureref-error pureref-error-embed" });
		panel.createDiv({ cls: "pureref-error-title", text: `PureRef board: ${this.file.name}` });
		panel.createDiv({ cls: "pureref-error-message", text: message });
	}
}

/**
 * Registers `.pur` embeds. Prefers Obsidian's (undocumented) embed registry, which serves both
 * reading view and live preview; falls back to a reading-view post-processor.
 */
export function registerPurEmbeds(plugin: PureRefPlugin): "registry" | "post-processor" {
	const registry = getEmbedRegistry(plugin);
	if (registry) {
		try {
			registry.registerExtensions(["pur"], (ctx: EmbedContext, file: TFile, subpath?: string) => {
				const sub = subpath ?? ctx.linktext?.split("#")[1];
				return new PurEmbed(plugin, file, ctx.containerEl, sub);
			});
			plugin.register(() => {
				try {
					registry.unregisterExtensions(["pur"]);
				} catch {
					// The registry may already be gone during app shutdown.
				}
			});
			return "registry";
		} catch {
			// Fall through to the post-processor.
		}
	}
	plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		for (const span of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
			if (span.dataset.purerefEmbed === "1") continue;
			const src = span.getAttribute("src");
			if (!src) continue;
			const hash = src.indexOf("#");
			const linkpath = hash < 0 ? src : src.slice(0, hash);
			const subpath = hash < 0 ? undefined : src.slice(hash + 1);
			if (!linkpath.toLowerCase().endsWith(".pur")) continue;
			const file = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, ctx.sourcePath);
			if (!(file instanceof TFile)) continue;
			span.dataset.purerefEmbed = "1";
			span.empty();
			const embed = new PurEmbed(plugin, file, span, subpath);
			ctx.addChild(embed);
			void embed.loadFile();
		}
	});
	return "post-processor";
}

function getEmbedRegistry(plugin: PureRefPlugin): EmbedRegistry | null {
	const registry = plugin.app.embedRegistry;
	if (
		registry &&
		typeof registry.registerExtensions === "function" &&
		typeof registry.unregisterExtensions === "function"
	) {
		return registry;
	}
	return null;
}
