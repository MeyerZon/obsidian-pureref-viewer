import { Component } from "obsidian";
import type { Rect } from "../pur/transform.ts";

export interface PanZoomState {
	x: number;
	y: number;
	scale: number;
}

export interface PanZoomOptions {
	minScale: number;
	maxScale: number;
	/** When true, plain wheel scrolls the page and only Ctrl/Cmd+wheel zooms (for embeds). */
	wheelRequiresModifier: boolean;
	onChange?: (state: PanZoomState, userInitiated: boolean) => void;
}

export function isPanZoomState(v: unknown): v is PanZoomState {
	if (!v || typeof v !== "object") return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.x === "number" &&
		typeof s.y === "number" &&
		typeof s.scale === "number" &&
		Number.isFinite(s.x) &&
		Number.isFinite(s.y) &&
		Number.isFinite(s.scale) &&
		s.scale > 0
	);
}

/**
 * Pointer/wheel pan-zoom controller. Applies `translate(x, y) scale(s)` to the world element;
 * the viewport element receives the input events.
 */
export class PanZoom extends Component {
	private readonly viewportEl: HTMLElement;
	private readonly worldEl: HTMLElement;
	private readonly opts: PanZoomOptions;
	private state: PanZoomState = { x: 0, y: 0, scale: 1 };
	private readonly pointers = new Map<number, { x: number; y: number }>();
	private pinchDistance = 0;
	private dragging = false;
	private dragStart = { x: 0, y: 0 };
	private dragMoved = false;
	private lastDragEnd = 0;
	userInteracted = false;

	constructor(viewportEl: HTMLElement, worldEl: HTMLElement, opts: PanZoomOptions) {
		super();
		this.viewportEl = viewportEl;
		this.worldEl = worldEl;
		this.opts = opts;
	}

	/** True right after a drag ended, so click handlers can ignore the release. */
	consumedClick(): boolean {
		return this.dragMoved || Date.now() - this.lastDragEnd < 150;
	}

	override onload(): void {
		this.registerDomEvent(this.viewportEl, "wheel", this.onWheel, { passive: false });
		this.registerDomEvent(this.viewportEl, "pointerdown", this.onPointerDown);
		this.registerDomEvent(this.viewportEl, "pointermove", this.onPointerMove);
		this.registerDomEvent(this.viewportEl, "pointerup", this.onPointerUp);
		this.registerDomEvent(this.viewportEl, "pointercancel", this.onPointerUp);
		this.registerDomEvent(this.viewportEl, "lostpointercapture", this.onPointerUp);
		this.apply();
	}

	override onunload(): void {
		this.pointers.clear();
	}

	getState(): PanZoomState {
		return { ...this.state };
	}

	setState(state: PanZoomState, userInitiated = false): void {
		const scale = this.clampScale(state.scale);
		this.state = { x: state.x, y: state.y, scale };
		if (userInitiated) this.userInteracted = true;
		// Applied synchronously so DOM measurements taken right after always match the state.
		this.apply();
		this.opts.onChange?.(this.getState(), userInitiated);
	}

	viewportSize(): { width: number; height: number } {
		return { width: this.viewportEl.clientWidth, height: this.viewportEl.clientHeight };
	}

	/** The scene-space rectangle currently visible. */
	visibleRect(): Rect {
		const { width, height } = this.viewportSize();
		const { x, y, scale } = this.state;
		return { x: -x / scale, y: -y / scale, width: width / scale, height: height / scale };
	}

	clientToScene(clientX: number, clientY: number): { x: number; y: number } {
		const r = this.viewportEl.getBoundingClientRect();
		return {
			x: (clientX - r.left - this.state.x) / this.state.scale,
			y: (clientY - r.top - this.state.y) / this.state.scale,
		};
	}

	/** Frames `rect` (scene space) inside the viewport. Returns false if the viewport has no size yet. */
	fitRect(rect: Rect, padding = 24, userInitiated = false): boolean {
		const { width, height } = this.viewportSize();
		if (width <= 0 || height <= 0) return false;
		const w = Math.max(rect.width, 1);
		const h = Math.max(rect.height, 1);
		const scale = this.clampScale(Math.min((width - 2 * padding) / w, (height - 2 * padding) / h));
		this.setState(
			{
				scale,
				x: (width - w * scale) / 2 - rect.x * scale,
				y: (height - h * scale) / 2 - rect.y * scale,
			},
			userInitiated,
		);
		return true;
	}

	/** Sets an absolute scale, keeping the given scene point (default: the viewport centre) fixed. */
	zoomTo(scale: number, userInitiated = false, center?: { x: number; y: number }): boolean {
		const { width, height } = this.viewportSize();
		if (width <= 0 || height <= 0) return false;
		const next = this.clampScale(scale);
		const c = center ?? this.clientCenterScene();
		this.setState(
			{
				scale: next,
				x: width / 2 - c.x * next,
				y: height / 2 - c.y * next,
			},
			userInitiated,
		);
		return true;
	}

	/** Multiplies the scale, keeping the viewport point (px, py) fixed. */
	zoomBy(factor: number, px?: number, py?: number, userInitiated = false): void {
		const { width, height } = this.viewportSize();
		const ax = px ?? width / 2;
		const ay = py ?? height / 2;
		const { x, y, scale } = this.state;
		const next = this.clampScale(scale * factor);
		const ratio = next / scale;
		this.setState({ scale: next, x: ax - (ax - x) * ratio, y: ay - (ay - y) * ratio }, userInitiated);
	}

	private clientCenterScene(): { x: number; y: number } {
		const { width, height } = this.viewportSize();
		const { x, y, scale } = this.state;
		return { x: (width / 2 - x) / scale, y: (height / 2 - y) / scale };
	}

	private clampScale(s: number): number {
		if (!Number.isFinite(s) || s <= 0) return this.opts.minScale;
		return Math.min(this.opts.maxScale, Math.max(this.opts.minScale, s));
	}

	private apply(): void {
		const { x, y, scale } = this.state;
		this.worldEl.setCssStyles({ transform: `translate(${x}px, ${y}px) scale(${scale})` });
	}

	private viewportPoint(clientX: number, clientY: number): { x: number; y: number } {
		const r = this.viewportEl.getBoundingClientRect();
		return { x: clientX - r.left, y: clientY - r.top };
	}

	private readonly onWheel = (e: WheelEvent): void => {
		if (this.opts.wheelRequiresModifier && !(e.ctrlKey || e.metaKey)) return;
		e.preventDefault();
		e.stopPropagation();
		const unit = e.deltaMode === 1 ? 0.06 : e.deltaMode === 2 ? 0.5 : 0.0018;
		const factor = Math.exp(-e.deltaY * unit);
		const p = this.viewportPoint(e.clientX, e.clientY);
		this.zoomBy(factor, p.x, p.y, true);
	};

	/**
	 * Pointer capture is taken lazily, once a drag really starts. Capturing on pointerdown would
	 * retarget the compatibility click/dblclick events to the viewport and break double-click on items.
	 */
	private capture(pointerId: number): void {
		try {
			if (!this.viewportEl.hasPointerCapture(pointerId)) this.viewportEl.setPointerCapture(pointerId);
		} catch {
			// Pointer capture can fail for synthetic events; dragging still works within the element.
		}
	}

	private readonly onPointerDown = (e: PointerEvent): void => {
		if (e.button !== 0 && e.button !== 1) return;
		if ((e.target as HTMLElement | null)?.closest?.("button, a, input")) return;
		if (e.button === 1) e.preventDefault();
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.pointers.size === 1) {
			this.dragging = true;
			this.dragMoved = false;
			this.dragStart = { x: e.clientX, y: e.clientY };
		} else if (this.pointers.size === 2) {
			this.pinchDistance = this.pointerDistance();
			for (const id of this.pointers.keys()) this.capture(id);
		}
	};

	private readonly onPointerMove = (e: PointerEvent): void => {
		const prev = this.pointers.get(e.pointerId);
		if (!prev) return;
		const cur = { x: e.clientX, y: e.clientY };
		this.pointers.set(e.pointerId, cur);
		if (this.pointers.size === 1 && this.dragging) {
			if (!this.dragMoved) {
				if (Math.hypot(cur.x - this.dragStart.x, cur.y - this.dragStart.y) < 3) return;
				this.dragMoved = true;
				this.capture(e.pointerId);
				this.viewportEl.addClass("pureref-dragging");
			}
			const { x, y, scale } = this.state;
			this.setState({ x: x + (cur.x - prev.x), y: y + (cur.y - prev.y), scale }, true);
		} else if (this.pointers.size === 2) {
			const dist = this.pointerDistance();
			const mid = this.pointerMidpoint();
			if (this.pinchDistance > 0 && dist > 0) {
				const p = this.viewportPoint(mid.x, mid.y);
				this.zoomBy(dist / this.pinchDistance, p.x, p.y, true);
			}
			this.pinchDistance = dist;
		}
	};

	private readonly onPointerUp = (e: PointerEvent): void => {
		if (!this.pointers.has(e.pointerId)) return;
		this.pointers.delete(e.pointerId);
		try {
			if (this.viewportEl.hasPointerCapture(e.pointerId)) this.viewportEl.releasePointerCapture(e.pointerId);
		} catch {
			// ignore
		}
		if (this.pointers.size === 0) {
			this.dragging = false;
			if (this.dragMoved) this.lastDragEnd = Date.now();
			this.dragMoved = false;
			this.viewportEl.removeClass("pureref-dragging");
		} else if (this.pointers.size === 1) {
			// Pinch ended with one finger still down: continue as a drag from its current position.
			this.dragging = true;
			this.dragMoved = true;
			this.pinchDistance = 0;
		}
	};

	private pointerDistance(): number {
		const [a, b] = [...this.pointers.values()];
		if (!a || !b) return 0;
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	private pointerMidpoint(): { x: number; y: number } {
		const [a, b] = [...this.pointers.values()];
		if (!a || !b) return { x: 0, y: 0 };
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}
}
