import type { Matrix, Rect } from "./transform.ts";

/** QPainterPath element types. */
export const PATH_MOVE_TO = 0;
export const PATH_LINE_TO = 1;
export const PATH_CURVE_TO = 2;
export const PATH_CURVE_TO_DATA = 3;

export interface PathElement {
	type: number;
	x: number;
	y: number;
}

export interface PainterPath {
	elements: PathElement[];
	subpathStart: number;
	fillRule: number;
}

export interface RgbaColor {
	r: number;
	g: number;
	b: number;
	/** 0..1 */
	a: number;
}

export const STROKE_STYLE_ROUND = 0;
export const STROKE_STYLE_DASHED = 1;
export const STROKE_STYLE_FLAT = 2;

export interface Stroke {
	color: RgbaColor;
	width: number;
	path: PainterPath;
	style: number;
}

export const SOURCE_EMBEDDED = 1;
export const SOURCE_LINKED = 2;

export interface ImageResource {
	id: number;
	sourceType: number;
	origin: string | null;
	source: string | null;
	/** PureRef's format string (e.g. "PNG", "JPG", or a lowercase file extension). */
	format: string | null;
	checksum: string | null;
	/** Original encoded bytes, or null for linked images. */
	data: Uint8Array | null;
	width: number;
	height: number;
	/** Sniffed from the bytes when possible. */
	mime: string;
	extension: string;
}

export interface ItemBase {
	id: number;
	parentId: number;
	name: string | null;
	/** Relative to the parent item (or the scene for root items). */
	transform: Matrix;
	/** Composed scene-space transform. */
	world: Matrix;
	sortOrder: number;
	z: number;
	opacity: number;
	locked: boolean;
	comment: string | null;
}

export const IMAGE_FLAG_BILINEAR = 0x1;
export const IMAGE_FLAG_GRAYSCALE = 0x2;

export interface ImageItem extends ItemBase {
	kind: "image";
	imageId: number;
	/** Maps image pixel coordinates to item-local coordinates. */
	imageTransform: Matrix;
	/** Clip path in item-local coordinates (the crop). */
	bounds: PainterPath;
	/** Bounding box of `bounds`, in item-local coordinates. */
	boundsRect: Rect;
	flags: number;
	playbackSpeed: number;
	playbackState: number;
	playbackFrame: number;
}

export interface NoteItem extends ItemBase {
	kind: "note";
	/** Qt rich-text HTML document. */
	html: string;
	textColor: string | null;
	backgroundColor: string | null;
	/** -1 means automatic. */
	fixedWidth: number;
	fixedHeight: number;
	/** 0 = comfortable, 1 = compact. */
	style: number;
}

export interface DrawingItem extends ItemBase {
	kind: "drawing";
	strokes: Stroke[];
}

export interface GroupItem extends ItemBase {
	kind: "group";
	backgroundColor: string | null;
	lockMode: number;
}

export type Item = ImageItem | NoteItem | DrawingItem | GroupItem;

export interface BoardMetadata {
	sceneRect: Rect | null;
	viewTransform: Matrix | null;
	applicationVersion: string | null;
	horizontalScroll: number;
	verticalScroll: number;
	lastSavePath: string | null;
	lastLoadPath: string | null;
	thumbnail: Uint8Array | null;
}

export interface Board {
	formatVersion: string;
	appVersion: string;
	checksum: string | null;
	thumbnail: Uint8Array | null;
	images: Map<number, ImageResource>;
	/** Sorted by paint order (ascending z). */
	items: Item[];
	metadata: BoardMetadata | null;
	warnings: string[];
}
