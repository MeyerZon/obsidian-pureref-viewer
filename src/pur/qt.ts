/**
 * Decoders for the Qt QDataStream encodings PureRef stores inside SQLite cells.
 * See https://github.com/FyorDev/pur-2-file-format (FORMAT.md) and
 * https://doc.qt.io/qt-6/datastreamformat.html.
 */
import { ByteReader, PurReadError, decodeUtf16BE, decodeUtf8Loose } from "./bytes.ts";
import type { PainterPath, PathElement, RgbaColor, Stroke } from "./model.ts";
import {
	PATH_CURVE_TO,
	PATH_CURVE_TO_DATA,
	PATH_LINE_TO,
	PATH_MOVE_TO,
	STROKE_STYLE_ROUND,
} from "./model.ts";
import type { Matrix, Rect } from "./transform.ts";

export const QVARIANT_QRECTF = 20;
export const QVARIANT_QSIZEF = 22;
export const QVARIANT_QTRANSFORM = 80;
export const QVARIANT_USER = 1024;

export const USER_TYPE_BIG_RATIONAL = "BigRational";
export const USER_TYPE_PAINTER_PATH = "QPainterPath";
export const USER_TYPE_STROKES = "QList<GraphicsDrawItem::Stroke>";

const NULL_LENGTH = 0xffffffff;

/** Qt QString: u32 byte length (0xFFFFFFFF = null) followed by UTF-16BE code units. */
export function readQString(r: ByteReader): string | null {
	const n = r.u32();
	if (n === NULL_LENGTH) return null;
	return decodeUtf16BE(r.bytesView(n));
}

/** Qt QByteArray: u32 byte length (0xFFFFFFFF = null) followed by raw bytes. */
export function readQByteArray(r: ByteReader): Uint8Array | null {
	const n = r.u32();
	if (n === NULL_LENGTH) return null;
	return r.bytesView(n);
}

/**
 * PureRef stores several binary QVariants in TEXT cells where every byte was mapped to the
 * code point U+0000..U+00FF and then UTF-8 encoded. This recovers the original bytes.
 */
export function latin1Unwrap(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c > 0xff) {
			throw new PurReadError(`Cell is not Latin-1 wrapped binary (code point U+${c.toString(16)} at ${i})`);
		}
		out[i] = c;
	}
	return out;
}

/** Accepts either a real BLOB or a Latin-1 wrapped TEXT cell. */
export function cellBytes(cell: string | Uint8Array | null): Uint8Array | null {
	if (cell === null) return null;
	if (typeof cell === "string") return latin1Unwrap(cell);
	return cell;
}

export interface VariantHeader {
	typeId: number;
	isNull: boolean;
	typeName: string | null;
}

export function readVariantHeader(r: ByteReader): VariantHeader {
	const typeId = r.u32();
	const isNull = r.u8() !== 0;
	let typeName: string | null = null;
	if (typeId === QVARIANT_USER) {
		const name = readQByteArray(r);
		if (name === null) throw new PurReadError("User QVariant without a type name");
		// The registered name includes its trailing NUL.
		const end = name.byteLength > 0 && name[name.byteLength - 1] === 0 ? name.byteLength - 1 : name.byteLength;
		typeName = decodeUtf8Loose(name.subarray(0, end));
	}
	return { typeId, isNull, typeName };
}

function expectVariant(r: ByteReader, typeId: number, typeName: string | null): VariantHeader {
	const h = readVariantHeader(r);
	if (h.typeId !== typeId || (typeName !== null && h.typeName !== typeName)) {
		const want = typeName ?? `type ${typeId}`;
		const got = h.typeName ?? `type ${h.typeId}`;
		throw new PurReadError(`Expected QVariant ${want}, found ${got}`);
	}
	return h;
}

export function readTransform(r: ByteReader): Matrix {
	return [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
}

export function readRectF(r: ByteReader): Rect {
	return { x: r.f64(), y: r.f64(), width: r.f64(), height: r.f64() };
}

export function readSizeF(r: ByteReader): { width: number; height: number } {
	return { width: r.f64(), height: r.f64() };
}

/** Bare QPainterPath payload (no QVariant wrapper). */
export function readPainterPath(r: ByteReader): PainterPath {
	const count = r.u32();
	if (count > r.remaining / 20) {
		throw new PurReadError(`QPainterPath claims ${count} elements but only ${r.remaining} bytes remain`);
	}
	const elements: PathElement[] = new Array<PathElement>(count);
	for (let i = 0; i < count; i++) {
		const type = r.i32();
		const x = r.f64();
		const y = r.f64();
		if (type < PATH_MOVE_TO || type > PATH_CURVE_TO_DATA) {
			throw new PurReadError(`Unknown QPainterPath element type ${type}`);
		}
		elements[i] = { type, x, y };
	}
	let subpathStart = 0;
	let fillRule = 0;
	if (count !== 0) {
		subpathStart = r.i32();
		fillRule = r.i32();
	}
	return { elements, subpathStart, fillRule };
}

/** Bare BigRational payload: two arbitrary-precision integers (numerator, denominator). */
export function readBigRational(r: ByteReader): { numerator: bigint; denominator: bigint } {
	const numerator = readBigInteger(r);
	const denominator = readBigInteger(r);
	return { numerator, denominator };
}

function readBigInteger(r: ByteReader): bigint {
	const sign = r.u32();
	const blockCount = r.u64();
	if (blockCount > 1024n) throw new PurReadError(`BigInteger with ${blockCount} blocks is not supported`);
	let value = 0n;
	const n = Number(blockCount);
	for (let i = 0; i < n; i++) {
		value |= BigInt(r.u32()) << BigInt(32 * i);
	}
	if (sign === 0xffffffff) return -value;
	if (sign === 0) return 0n;
	return value;
}

export function rationalToNumber(q: { numerator: bigint; denominator: bigint }): number {
	if (q.denominator === 0n) return 0;
	// Keep precision for the common small case; fall back to floating division otherwise.
	return Number(q.numerator) / Number(q.denominator);
}

function readQColorRgb(r: ByteReader): RgbaColor {
	const spec = r.i8();
	const alpha = r.u16();
	const red = r.u16();
	const green = r.u16();
	const blue = r.u16();
	r.u16(); // pad
	if (spec !== 1) {
		// Spec 1 is RGB. Other specs (HSV, CMYK, HSL) are not produced by PureRef; treat as RGB anyway.
	}
	return {
		r: Math.round(red / 257),
		g: Math.round(green / 257),
		b: Math.round(blue / 257),
		a: alpha / 65535,
	};
}

/** Bare QList<GraphicsDrawItem::Stroke> payload (no QVariant wrapper). */
export function readStrokes(r: ByteReader): Stroke[] {
	const count = r.u32();
	if (count > r.remaining / 24) {
		throw new PurReadError(`Stroke list claims ${count} strokes but only ${r.remaining} bytes remain`);
	}
	const strokes: Stroke[] = [];
	for (let i = 0; i < count; i++) {
		const versionPos = r.pos;
		let version = r.i8();
		if (version <= 99) {
			// Legacy stroke without a version byte: the QColor spec starts here.
			r.pos = versionPos;
			version = 0;
		}
		const color = readQColorRgb(r);
		const width = r.f64();
		const path = readPainterPath(r);
		r.f64(); // transient QPointF x (draw state, ignored)
		r.f64(); // transient QPointF y
		const style = version > 99 ? r.i32() : STROKE_STYLE_ROUND;
		strokes.push({ color, width, path, style });
	}
	return strokes;
}

// ---- Cell-level helpers (QVariant-wrapped) -------------------------------------------------

export function parseTransformCell(cell: string | Uint8Array | null): Matrix | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_QTRANSFORM, null);
	if (h.isNull) return null;
	return readTransform(r);
}

export function parseRectFCell(cell: string | Uint8Array | null): Rect | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_QRECTF, null);
	if (h.isNull) return null;
	return readRectF(r);
}

export function parseSizeFCell(cell: string | Uint8Array | null): { width: number; height: number } | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_QSIZEF, null);
	if (h.isNull) return null;
	return readSizeF(r);
}

export function parsePainterPathCell(cell: string | Uint8Array | null): PainterPath | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_USER, USER_TYPE_PAINTER_PATH);
	if (h.isNull) return null;
	return readPainterPath(r);
}

export function parseBigRationalCell(cell: string | Uint8Array | null): number | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_USER, USER_TYPE_BIG_RATIONAL);
	if (h.isNull) return null;
	return rationalToNumber(readBigRational(r));
}

export interface StrokesParse {
	strokes: Stroke[];
	/** Bytes consumed vs. available, for diagnostics. */
	consumed: number;
	total: number;
}

export function parseStrokesCell(cell: string | Uint8Array | null): StrokesParse | null {
	const bytes = cellBytes(cell);
	if (!bytes) return null;
	const r = new ByteReader(bytes);
	const h = expectVariant(r, QVARIANT_USER, USER_TYPE_STROKES);
	if (h.isNull) return { strokes: [], consumed: r.pos, total: bytes.byteLength };
	const strokes = readStrokes(r);
	return { strokes, consumed: r.pos, total: bytes.byteLength };
}

/** Bounding box of a painter path (control points included), or null when empty. */
export function painterPathBounds(path: PainterPath): Rect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const e of path.elements) {
		if (e.x < minX) minX = e.x;
		if (e.y < minY) minY = e.y;
		if (e.x > maxX) maxX = e.x;
		if (e.y > maxY) maxY = e.y;
	}
	if (minX === Infinity) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** True when the path is a closed axis-aligned rectangle (moveTo + 4 lineTo, last == first). */
export function isAxisAlignedRectPath(path: PainterPath): boolean {
	const e = path.elements;
	if (e.length !== 5) return false;
	const first = e[0] as PathElement;
	const last = e[4] as PathElement;
	if (first.type !== PATH_MOVE_TO) return false;
	for (let i = 1; i < 5; i++) if ((e[i] as PathElement).type !== PATH_LINE_TO) return false;
	if (first.x !== last.x || first.y !== last.y) return false;
	for (let i = 0; i < 4; i++) {
		const a = e[i] as PathElement;
		const b = e[i + 1] as PathElement;
		if (a.x !== b.x && a.y !== b.y) return false;
	}
	return true;
}

/** SVG path data for a painter path (cubic triples become `C` commands). */
export function painterPathToSvg(path: PainterPath): string {
	const parts: string[] = [];
	const e = path.elements;
	for (let i = 0; i < e.length; i++) {
		const el = e[i] as PathElement;
		switch (el.type) {
			case PATH_MOVE_TO:
				parts.push(`M${num(el.x)} ${num(el.y)}`);
				break;
			case PATH_LINE_TO:
				parts.push(`L${num(el.x)} ${num(el.y)}`);
				break;
			case PATH_CURVE_TO: {
				const c2 = e[i + 1];
				const end = e[i + 2];
				if (!c2 || !end) {
					parts.push(`L${num(el.x)} ${num(el.y)}`);
					break;
				}
				parts.push(`C${num(el.x)} ${num(el.y)} ${num(c2.x)} ${num(c2.y)} ${num(end.x)} ${num(end.y)}`);
				i += 2;
				break;
			}
			default:
				// A stray curve-data element without its leading CurveTo: treat as a line.
				parts.push(`L${num(el.x)} ${num(el.y)}`);
		}
	}
	return parts.join(" ");
}

function num(n: number): string {
	return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0";
}

/** Converts Qt's `#AARRGGBB` (or `#RRGGBB`) colour strings to CSS. Returns null for empty/invalid. */
export function qtColorToCss(color: string | null): string | null {
	if (!color) return null;
	const m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
	if (!m) return null;
	const hex = m[1] as string;
	if (hex.length === 6) return `#${hex}`;
	const a = parseInt(hex.slice(0, 2), 16) / 255;
	const rr = parseInt(hex.slice(2, 4), 16);
	const gg = parseInt(hex.slice(4, 6), 16);
	const bb = parseInt(hex.slice(6, 8), 16);
	return `rgba(${rr}, ${gg}, ${bb}, ${Math.round(a * 1000) / 1000})`;
}

export function rgbaToCss(c: RgbaColor): string {
	return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 1000) / 1000})`;
}
