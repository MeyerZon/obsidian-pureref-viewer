/**
 * Scene-space extents that can be computed without a DOM (images and drawings).
 * Notes need layout measurement and are handled by the renderer.
 */
import type { Board, DrawingItem, ImageItem, Item } from "./model.ts";
import { apply, boundsOfPoints, inflateRect, invert, transformRect, unionRect, type Rect } from "./transform.ts";

/**
 * The visible crop of an image item in image-pixel space (origin at the image's top-left),
 * or null when the item shows the whole image.
 */
export function imageCropRect(item: ImageItem, width: number, height: number): Rect | null {
	const inv = invert(item.imageTransform);
	if (!inv || width <= 0 || height <= 0) return null;
	const r = transformRect(inv, item.boundsRect);
	const x0 = clamp(r.x, 0, width);
	const y0 = clamp(r.y, 0, height);
	const x1 = clamp(r.x + r.width, 0, width);
	const y1 = clamp(r.y + r.height, 0, height);
	if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
	if (x0 < 0.5 && y0 < 0.5 && width - x1 < 0.5 && height - y1 < 0.5) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** Axis-aligned scene rect of an image item's visible (cropped) area. */
export function imageItemRect(item: ImageItem): Rect {
	// `bounds` is already in item-local space, so only the item's world matrix applies.
	return transformRect(item.world, item.boundsRect);
}

/** Axis-aligned scene rect covering all strokes of a drawing, or null when empty. */
export function drawingItemRect(item: DrawingItem): Rect | null {
	let rect: Rect | null = null;
	for (const stroke of item.strokes) {
		const local = boundsOfPoints(stroke.path.elements);
		if (!local) continue;
		rect = unionRect(rect, transformRect(item.world, inflateRect(local, stroke.width / 2)));
	}
	return rect;
}

/** Local-space bounding box of a drawing's strokes (for sizing an SVG), or null when empty. */
export function drawingLocalRect(item: DrawingItem): Rect | null {
	let rect: Rect | null = null;
	let maxWidth = 0;
	for (const stroke of item.strokes) {
		rect = unionRect(rect, boundsOfPoints(stroke.path.elements));
		maxWidth = Math.max(maxWidth, stroke.width);
	}
	return rect ? inflateRect(rect, maxWidth / 2 + 1) : null;
}

export function itemStaticRect(item: Item): Rect | null {
	switch (item.kind) {
		case "image":
			return imageItemRect(item);
		case "drawing":
			return drawingItemRect(item);
		default:
			return null;
	}
}

/** Union of all statically computable item rects (images + drawings). */
export function boardStaticBounds(board: Board): Rect | null {
	let rect: Rect | null = null;
	for (const item of board.items) rect = unionRect(rect, itemStaticRect(item));
	return rect;
}

/** Scene position of an item's local origin. */
export function itemOrigin(item: Item): { x: number; y: number } {
	return apply(item.world, 0, 0);
}
