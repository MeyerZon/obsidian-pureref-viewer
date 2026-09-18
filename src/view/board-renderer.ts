import { Component } from "obsidian";
import { boardStaticBounds, drawingLocalRect, imageItemRect } from "../pur/bounds.ts";
import type { Board, DrawingItem, ImageItem, ImageResource, Item, NoteItem } from "../pur/model.ts";
import { IMAGE_FLAG_BILINEAR, IMAGE_FLAG_GRAYSCALE, STROKE_STYLE_DASHED, STROKE_STYLE_FLAT } from "../pur/model.ts";
import { isAxisAlignedRectPath, painterPathToSvg, qtColorToCss, rgbaToCss } from "../pur/qt.ts";
import { apply, fmt, invert, toCssMatrix, transformRect, unionRect, type Rect } from "../pur/transform.ts";
import type { BoardBackground, InitialView } from "../settings.ts";
import { renderNoteHtml } from "./note-html.ts";
import { PanZoom, type PanZoomState } from "./panzoom.ts";

export interface RendererOptions {
	showNotes: boolean;
	showDrawings: boolean;
	background: BoardBackground;
	initialView: InitialView;
	wheelRequiresModifier: boolean;
	/** Restores a previously saved view instead of applying `initialView`. */
	initialState?: PanZoomState | null;
	onViewChange?: (state: PanZoomState) => void;
}

const MIN_SCALE = 0.002;
const MAX_SCALE = 8;
const FIT_PADDING = 32;
/** Notes and images are centre-anchored in PureRef: the item origin is the element's centre. */
const NOTE_ANCHOR: "center" | "topleft" = "center";

/**
 * Renders a parsed board into DOM: `.pureref-viewport > .pureref-world > .pureref-item*`.
 * Owns the object URLs for embedded images and the pan/zoom controller.
 */
export class BoardRenderer extends Component {
	readonly board: Board;
	readonly options: RendererOptions;
	private readonly hostEl: HTMLElement;
	viewportEl!: HTMLElement;
	worldEl!: HTMLElement;
	panzoom!: PanZoom;
	private readonly objectUrls = new Map<number, string>();
	private readonly noteEls: { item: NoteItem; el: HTMLElement }[] = [];
	private measuredNotes: Rect | null | undefined = undefined;
	private initialViewApplied = false;
	private alive = false;

	constructor(hostEl: HTMLElement, board: Board, options: RendererOptions) {
		super();
		this.hostEl = hostEl;
		this.board = board;
		this.options = options;
	}

	override onload(): void {
		this.alive = true;
		this.viewportEl = this.hostEl.createDiv({ cls: "pureref-viewport" });
		this.viewportEl.addClass(this.options.background === "theme" ? "pureref-bg-theme" : "pureref-bg-pureref");
		this.worldEl = this.viewportEl.createDiv({ cls: "pureref-world" });
		this.panzoom = new PanZoom(this.viewportEl, this.worldEl, {
			minScale: MIN_SCALE,
			maxScale: MAX_SCALE,
			wheelRequiresModifier: this.options.wheelRequiresModifier,
			onChange: (state, user) => {
				if (user) this.options.onViewChange?.(state);
			},
		});
		this.addChild(this.panzoom);

		let rendered = 0;
		for (const item of this.board.items) {
			if (this.renderItem(item)) rendered++;
		}
		if (rendered === 0) {
			this.viewportEl.createDiv({ cls: "pureref-empty", text: "This board is empty." });
		}

		this.ensureInitialView();
		const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
		if (fonts?.ready) {
			void fonts.ready.then(() => {
				if (!this.alive) return;
				this.measuredNotes = undefined;
				if (!this.panzoom.userInteracted && !this.options.initialState) {
					this.initialViewApplied = false;
					this.ensureInitialView();
				}
			});
		}
	}

	override onunload(): void {
		this.alive = false;
		for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
		this.objectUrls.clear();
		this.noteEls.length = 0;
		this.viewportEl?.detach();
	}

	// ---- View control ----------------------------------------------------------------------

	/** Applies the initial view once the viewport has a size. Safe to call repeatedly (e.g. on resize). */
	ensureInitialView(): void {
		if (this.initialViewApplied || !this.alive) return;
		const { width, height } = this.panzoom.viewportSize();
		if (width <= 0 || height <= 0) return;
		const saved = this.options.initialState;
		if (saved) {
			this.panzoom.setState(saved);
			this.initialViewApplied = true;
			return;
		}
		switch (this.options.initialView) {
			case "actual":
				this.initialViewApplied = this.zoomActual();
				break;
			case "saved":
				this.initialViewApplied = this.applySavedView();
				break;
			default:
				this.initialViewApplied = this.fitAll();
		}
	}

	fitAll(userInitiated = false): boolean {
		const bounds = this.contentBounds();
		if (!bounds) return this.panzoom.zoomTo(1, userInitiated, { x: 0, y: 0 });
		return this.panzoom.fitRect(bounds, FIT_PADDING, userInitiated);
	}

	zoomActual(userInitiated = false): boolean {
		const bounds = this.contentBounds();
		const center = bounds
			? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
			: { x: 0, y: 0 };
		return this.panzoom.zoomTo(1, userInitiated, center);
	}

	zoomBy(factor: number, userInitiated = true): void {
		this.panzoom.zoomBy(factor, undefined, undefined, userInitiated);
	}

	private applySavedView(): boolean {
		const meta = this.board.metadata;
		const scale = meta?.viewTransform?.[0];
		if (!meta || !scale || !Number.isFinite(scale) || scale <= 0) return this.fitAll();
		const rect = meta.sceneRect ?? this.contentBounds();
		if (!rect) return this.fitAll();
		return this.panzoom.zoomTo(scale, false, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
	}

	/** Scene-space bounds of everything rendered (images, drawings and measured notes). */
	contentBounds(): Rect | null {
		let rect = boardStaticBounds(this.board);
		if (this.measuredNotes === undefined) this.measuredNotes = this.measureNotes();
		rect = unionRect(rect, this.measuredNotes);
		return rect;
	}

	private measureNotes(): Rect | null {
		if (this.noteEls.length === 0) return null;
		const vp = this.viewportEl.getBoundingClientRect();
		const { x, y, scale } = this.panzoom.getState();
		if (scale <= 0) return null;
		let rect: Rect | null = null;
		for (const { el } of this.noteEls) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			rect = unionRect(rect, {
				x: (r.left - vp.left - x) / scale,
				y: (r.top - vp.top - y) / scale,
				width: r.width / scale,
				height: r.height / scale,
			});
		}
		return rect;
	}

	// ---- Item rendering --------------------------------------------------------------------

	private renderItem(item: Item): boolean {
		switch (item.kind) {
			case "image":
				this.renderImage(item);
				return true;
			case "note":
				if (!this.options.showNotes) return false;
				this.renderNote(item);
				return true;
			case "drawing":
				if (!this.options.showDrawings) return false;
				return this.renderDrawing(item);
			default:
				// Groups have no geometry of their own; children carry composed transforms.
				return false;
		}
	}

	private itemElement(item: Item, kind: string, transform: string): HTMLElement {
		const el = this.worldEl.createDiv({
			cls: `pureref-item pureref-item-${kind}`,
			attr: { "data-pureref-id": String(item.id) },
		});
		const styles: Partial<CSSStyleDeclaration> = { transform };
		if (item.opacity < 1) styles.opacity = String(item.opacity);
		el.setCssStyles(styles);
		if (item.name) el.setAttribute("aria-label", item.name);
		return el;
	}

	private renderImage(item: ImageItem): void {
		const res = this.board.images.get(item.imageId);
		const width = res?.width || Math.max(1, Math.round(item.boundsRect.width));
		const height = res?.height || Math.max(1, Math.round(item.boundsRect.height));
		const itemEl = this.itemElement(item, "image", toCssMatrix(item.world));
		const frame = itemEl.createDiv({ cls: "pureref-image-frame" });
		const frameStyles: Partial<CSSStyleDeclaration> = {
			width: `${width}px`,
			height: `${height}px`,
			transform: toCssMatrix(item.imageTransform),
		};
		const clip = this.clipPathFor(item, width, height);
		if (clip) frameStyles.clipPath = clip;
		frame.setCssStyles(frameStyles);

		if (res?.data && res.data.byteLength > 0) {
			const img = frame.createEl("img", {
				cls: "pureref-image",
				attr: {
					draggable: "false",
					alt: item.name ?? "",
					width: String(width),
					height: String(height),
					loading: "lazy",
					decoding: "async",
				},
			});
			if ((item.flags & IMAGE_FLAG_BILINEAR) === 0) img.addClass("pureref-pixelated");
			if (item.flags & IMAGE_FLAG_GRAYSCALE) img.addClass("pureref-grayscale");
			img.src = this.objectUrlFor(res);
		} else {
			frame.addClass("pureref-missing");
			const label = res?.source ?? res?.origin ?? `Image ${item.imageId} is missing`;
			frame.createDiv({ cls: "pureref-missing-label", text: label });
		}

		this.registerDomEvent(itemEl, "dblclick", (e) => {
			e.preventDefault();
			this.panzoom.fitRect(imageItemRect(item), 48, true);
		});
	}

	/** CSS clip-path in image-pixel space for the item's crop, or "" when uncropped. */
	private clipPathFor(item: ImageItem, width: number, height: number): string {
		const inv = invert(item.imageTransform);
		if (!inv) return "";
		if (isAxisAlignedRectPath(item.bounds)) {
			const r = transformRect(inv, item.boundsRect);
			const top = Math.max(0, r.y);
			const left = Math.max(0, r.x);
			const right = Math.max(0, width - (r.x + r.width));
			const bottom = Math.max(0, height - (r.y + r.height));
			if (top < 0.5 && left < 0.5 && right < 0.5 && bottom < 0.5) return "";
			return `inset(${fmt(top)}px ${fmt(right)}px ${fmt(bottom)}px ${fmt(left)}px)`;
		}
		const mapped = {
			...item.bounds,
			elements: item.bounds.elements.map((e) => ({ ...e, ...apply(inv, e.x, e.y) })),
		};
		const d = painterPathToSvg(mapped);
		return d ? `path("${d} Z")` : "";
	}

	private objectUrlFor(res: ImageResource): string {
		const existing = this.objectUrls.get(res.id);
		if (existing) return existing;
		const data = res.data as Uint8Array;
		// Copy the bytes so the Blob does not pin the whole file buffer.
		const blob = new Blob([data.slice()], { type: res.mime });
		const url = URL.createObjectURL(blob);
		this.objectUrls.set(res.id, url);
		return url;
	}

	private renderNote(item: NoteItem): void {
		const transform =
			NOTE_ANCHOR === "center" ? `${toCssMatrix(item.world)} translate(-50%, -50%)` : toCssMatrix(item.world);
		const itemEl = this.itemElement(item, "note", transform);
		const note = itemEl.createDiv({
			cls: `pureref-note ${item.style === 1 ? "pureref-note-compact" : "pureref-note-comfortable"}`,
		});
		const styles: Partial<CSSStyleDeclaration> = {};
		if (item.fixedWidth > 0) styles.width = `${fmt(item.fixedWidth)}px`;
		if (item.fixedHeight > 0) styles.height = `${fmt(item.fixedHeight)}px`;
		const bg = qtColorToCss(item.backgroundColor);
		if (bg) styles.backgroundColor = bg;
		const fg = qtColorToCss(item.textColor);
		if (fg) styles.color = fg;
		if (Object.keys(styles).length > 0) note.setCssStyles(styles);
		renderNoteHtml(note, item.html);
		this.noteEls.push({ item, el: note });
	}

	private renderDrawing(item: DrawingItem): boolean {
		const local = drawingLocalRect(item);
		if (!local || item.strokes.length === 0) return false;
		const itemEl = this.itemElement(item, "drawing", toCssMatrix(item.world));
		const box = itemEl.createDiv({ cls: "pureref-drawing-box" });
		box.setCssStyles({
			left: `${fmt(local.x)}px`,
			top: `${fmt(local.y)}px`,
			width: `${fmt(local.width)}px`,
			height: `${fmt(local.height)}px`,
		});
		const svg = box.createSvg("svg", {
			attr: {
				viewBox: `${fmt(local.x)} ${fmt(local.y)} ${fmt(local.width)} ${fmt(local.height)}`,
				preserveAspectRatio: "none",
			},
		});
		for (const stroke of item.strokes) {
			const d = painterPathToSvg(stroke.path);
			if (!d) continue;
			const attr: Record<string, string> = {
				d,
				fill: "none",
				stroke: rgbaToCss(stroke.color),
				"stroke-width": fmt(stroke.width),
				"stroke-linecap": stroke.style === STROKE_STYLE_FLAT ? "butt" : "round",
				"stroke-linejoin": "round",
			};
			if (stroke.style === STROKE_STYLE_DASHED) attr["stroke-dasharray"] = `${fmt(stroke.width * 2)} ${fmt(stroke.width * 2)}`;
			svg.createSvg("path", { attr });
		}
		return true;
	}
}
