/**
 * PureRef 2.x `.pur` parser.
 *
 * A 2.x file is an SQLite database whose first H bytes were moved to the end of the file and
 * replaced by a small Qt-serialized header:
 *
 *   offset 0   header (H bytes)
 *   offset H   database[H .. N]
 *   offset N   database[0 .. H]   (the displaced prefix)
 *
 * Format reference: https://github.com/FyorDev/pur-2-file-format
 */
import { ByteReader, PurReadError, asciiBytes, bytesStartWith, toSafeNumber } from "./bytes.ts";
import { sniffImageType } from "./image-type.ts";
import type {
	Board,
	BoardMetadata,
	DrawingItem,
	GroupItem,
	ImageItem,
	ImageResource,
	Item,
	ItemBase,
	NoteItem,
	PainterPath,
} from "./model.ts";
import {
	painterPathBounds,
	parseBigRationalCell,
	parsePainterPathCell,
	parseRectFCell,
	parseSizeFCell,
	parseStrokesCell,
	parseTransformCell,
	readQByteArray,
	readQString,
} from "./qt.ts";
import { SqliteDatabase, findSqliteMagic, isSqliteDatabase, type SqlRow, type SqlValue } from "./sqlite.ts";
import { IDENTITY, isAffine, mul, type Matrix } from "./transform.ts";

export class PurFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PurFormatError";
	}
}

export interface PurHeader {
	formatVersion: string;
	appVersion: string;
	checksum: string | null;
	thumbnail: Uint8Array | null;
	/** Length of the SQLite database (and offset of the displaced prefix). */
	databaseLength: number;
	/** Length of the PureRef header (H). */
	headerLength: number;
	/** Offset where the checksummed region starts (right after the checksum string). */
	checksumStart: number;
}

const SQLITE_MAGIC = asciiBytes("SQLite format 3\0");

export function parseHeader(bytes: Uint8Array): PurHeader {
	const r = new ByteReader(bytes);
	const formatVersion = readQString(r);
	if (formatVersion === null || !/^\d+(\.\d+)*$/.test(formatVersion)) {
		throw new PurFormatError("Not a PureRef file (missing format version)");
	}
	const major = parseInt(formatVersion, 10);
	if (major < 2) {
		throw new PurFormatError(
			`PureRef ${formatVersion} files are not supported. Open and re-save the board in PureRef 2 to convert it.`,
		);
	}
	if (major > 2) {
		throw new PurFormatError(`PureRef format ${formatVersion} is newer than this plugin supports.`);
	}
	r.u32(); // reserved, always 0
	const databaseLength = toSafeNumber(r.u64(), "Database length");
	const appVersion = readQString(r) ?? "";
	const checksum = readQString(r);
	const checksumStart = r.pos;
	let thumbnail: Uint8Array | null = null;
	// 2.0 envelopes have no thumbnail field at all.
	if (!/^2\.0(\.|$)/.test(formatVersion)) {
		thumbnail = readQByteArray(r);
		if (thumbnail && thumbnail.byteLength === 0) thumbnail = null;
	}
	return {
		formatVersion,
		appVersion,
		checksum,
		thumbnail,
		databaseLength,
		headerLength: r.pos,
		checksumStart,
	};
}

/** Re-assembles the SQLite database from the displaced layout. */
export function reconstructDatabase(bytes: Uint8Array, header: PurHeader, warnings: string[]): Uint8Array {
	let n = header.databaseLength;
	let h = header.headerLength;
	const consistent = n > 0 && h > 0 && n + h === bytes.byteLength && isSqliteDatabase(bytes, n);
	if (!consistent) {
		const at = findSqliteMagic(bytes);
		if (at < 0) throw new PurFormatError("No SQLite database found inside the file (corrupt or unsupported).");
		warnings.push(
			`Header did not match the file layout (N=${n}, H=${h}, size=${bytes.byteLength}); recovered from the SQLite signature at ${at}.`,
		);
		n = at;
		h = bytes.byteLength - n;
	}
	if (h > n) throw new PurFormatError("Corrupt file: header is longer than the database.");
	const db = new Uint8Array(n);
	db.set(bytes.subarray(n, n + h), 0);
	db.set(bytes.subarray(h, n), h);
	if (!bytesStartWith(db, SQLITE_MAGIC)) throw new PurFormatError("Reconstructed database has a bad signature.");
	return db;
}

// ---- Row access helpers ------------------------------------------------------------------------

class Table {
	readonly rows: SqlRow[];
	private readonly index = new Map<string, number>();

	constructor(db: SqliteDatabase, name: string) {
		const t = db.tables.get(name);
		this.rows = t ? db.readTable(name) : [];
		t?.columns.forEach((c, i) => this.index.set(c, i));
	}

	get(row: SqlRow, column: string): SqlValue {
		const i = this.index.get(column);
		return i === undefined ? null : (row.values[i] ?? null);
	}

	num(row: SqlRow, column: string, fallback = 0): number {
		const v = this.get(row, column);
		if (typeof v === "number") return v;
		if (typeof v === "bigint") return Number(v);
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : fallback;
		}
		return fallback;
	}

	str(row: SqlRow, column: string): string | null {
		const v = this.get(row, column);
		if (v === null) return null;
		if (typeof v === "string") return v;
		if (typeof v === "number" || typeof v === "bigint") return String(v);
		return null;
	}

	bin(row: SqlRow, column: string): string | Uint8Array | null {
		const v = this.get(row, column);
		if (v === null) return null;
		if (typeof v === "string" || v instanceof Uint8Array) return v;
		return null;
	}

	blob(row: SqlRow, column: string): Uint8Array | null {
		const v = this.get(row, column);
		return v instanceof Uint8Array ? v : null;
	}
}

// ---- Main entry point --------------------------------------------------------------------------

export function parsePur(input: ArrayBuffer | Uint8Array): Board {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const warnings: string[] = [];
	const header = parseHeader(bytes);
	const dbBytes = reconstructDatabase(bytes, header, warnings);
	warnings.push("File checksum was not verified (MD5 is not available in this environment).");

	let db: SqliteDatabase;
	try {
		db = new SqliteDatabase(dbBytes);
	} catch (e) {
		throw new PurFormatError(`Could not read the board database: ${e instanceof Error ? e.message : String(e)}`);
	}
	for (const required of ["images", "items", "items_images"]) {
		if (!db.hasTable(required)) throw new PurFormatError(`Board database is missing the "${required}" table.`);
	}

	const images = readImages(db, warnings);
	const items = readItems(db, images, warnings);
	const metadata = readMetadata(db, warnings);
	warnings.push(...db.warnings);

	return {
		formatVersion: header.formatVersion,
		appVersion: header.appVersion,
		checksum: header.checksum,
		thumbnail: header.thumbnail ?? metadata?.thumbnail ?? null,
		images,
		items,
		metadata,
		warnings,
	};
}

function readImages(db: SqliteDatabase, warnings: string[]): Map<number, ImageResource> {
	const t = new Table(db, "images");
	const out = new Map<number, ImageResource>();
	for (const row of t.rows) {
		const id = row.rowid;
		const data = t.blob(row, "data");
		const format = t.str(row, "format");
		const type = sniffImageType(data, format);
		const sourceType = t.num(row, "source_type", data ? 1 : 2);
		if (sourceType === 1 && !data) {
			warnings.push(`Image ${id} is marked embedded but has no data.`);
		}
		out.set(id, {
			id,
			sourceType,
			origin: t.str(row, "origin"),
			source: t.str(row, "source"),
			format,
			checksum: t.str(row, "checksum"),
			data,
			width: t.num(row, "width"),
			height: t.num(row, "height"),
			mime: type.mime,
			extension: type.extension,
		});
	}
	return out;
}

interface BaseRecord extends ItemBase {
	resolved: boolean;
}

function readItems(db: SqliteDatabase, images: Map<number, ImageResource>, warnings: string[]): Item[] {
	const items = new Table(db, "items");
	const bases = new Map<number, BaseRecord>();
	for (const row of items.rows) {
		const id = row.rowid;
		let transform: Matrix = IDENTITY;
		try {
			transform = parseTransformCell(items.bin(row, "transform")) ?? IDENTITY;
		} catch (e) {
			warnings.push(`Item ${id}: unreadable transform (${msg(e)}); using identity.`);
		}
		if (!isAffine(transform)) {
			warnings.push(`Item ${id}: transform is not affine; perspective components were ignored.`);
			transform = [transform[0], transform[1], 0, transform[3], transform[4], 0, transform[6], transform[7], 1];
		}
		let sortOrder = 0;
		try {
			sortOrder = parseBigRationalCell(items.bin(row, "sort_order")) ?? 0;
		} catch (e) {
			warnings.push(`Item ${id}: unreadable sort order (${msg(e)}).`);
		}
		bases.set(id, {
			id,
			parentId: items.num(row, "parent", -1),
			name: items.str(row, "name"),
			transform,
			world: transform,
			sortOrder,
			z: items.num(row, "z"),
			opacity: clamp01(items.num(row, "opacity", 1)),
			locked: items.num(row, "locked") !== 0,
			comment: items.str(row, "comment"),
			resolved: false,
		});
	}

	// Compose world transforms through parent chains (any item kind may be a parent).
	const resolve = (id: number, trail: Set<number>): Matrix => {
		const base = bases.get(id);
		if (!base) return IDENTITY;
		if (base.resolved) return base.world;
		if (trail.has(id)) {
			warnings.push(`Item ${id}: parent cycle detected; treated as a root item.`);
			base.resolved = true;
			return base.world;
		}
		trail.add(id);
		const parent = base.parentId;
		if (parent >= 0 && parent !== id && bases.has(parent)) {
			base.world = mul(base.transform, resolve(parent, trail));
		} else {
			base.world = base.transform;
		}
		base.resolved = true;
		return base.world;
	};
	for (const id of bases.keys()) resolve(id, new Set());

	const out: Item[] = [];
	const typed = new Set<number>();
	const baseFor = (id: number, kind: string): ItemBase | null => {
		const b = bases.get(id);
		if (!b) {
			warnings.push(`${kind} ${id} has no matching item row; skipped.`);
			return null;
		}
		if (typed.has(id)) {
			warnings.push(`Item ${id} appears in more than one subtype table; keeping the first.`);
			return null;
		}
		typed.add(id);
		const { resolved: _resolved, ...rest } = b;
		return rest;
	};

	const imgs = new Table(db, "items_images");
	for (const row of imgs.rows) {
		const base = baseFor(row.rowid, "Image item");
		if (!base) continue;
		const imageId = imgs.num(row, "image", -1);
		const res = images.get(imageId);
		if (!res) warnings.push(`Image item ${base.id} references missing image ${imageId}.`);
		const w = res?.width ?? 0;
		const h = res?.height ?? 0;
		let imageTransform: Matrix = [1, 0, 0, 0, 1, 0, -w / 2, -h / 2, 1];
		try {
			imageTransform = parseTransformCell(imgs.bin(row, "image_transform")) ?? imageTransform;
		} catch (e) {
			warnings.push(`Image item ${base.id}: unreadable image transform (${msg(e)}); assuming centred.`);
		}
		let bounds: PainterPath | null = null;
		try {
			bounds = parsePainterPathCell(imgs.bin(row, "image_bounds"));
		} catch (e) {
			warnings.push(`Image item ${base.id}: unreadable crop bounds (${msg(e)}); showing the full image.`);
		}
		if (!bounds || bounds.elements.length === 0) bounds = fullRectPath(w, h);
		const boundsRect = painterPathBounds(bounds) ?? { x: -w / 2, y: -h / 2, width: w, height: h };
		const item: ImageItem = {
			...base,
			kind: "image",
			imageId,
			imageTransform,
			bounds,
			boundsRect,
			flags: imgs.num(row, "flags", 1),
			playbackSpeed: imgs.num(row, "playback_speed", 1),
			playbackState: imgs.num(row, "playback_state"),
			playbackFrame: imgs.num(row, "playback_frame"),
		};
		out.push(item);
	}

	const notes = new Table(db, "items_notes");
	for (const row of notes.rows) {
		const base = baseFor(row.rowid, "Note");
		if (!base) continue;
		let size = { width: -1, height: -1 };
		try {
			size = parseSizeFCell(notes.bin(row, "fixed_size")) ?? size;
		} catch (e) {
			warnings.push(`Note ${base.id}: unreadable fixed size (${msg(e)}).`);
		}
		const item: NoteItem = {
			...base,
			kind: "note",
			html: notes.str(row, "text") ?? "",
			textColor: emptyToNull(notes.str(row, "text_color")),
			backgroundColor: emptyToNull(notes.str(row, "background_color")),
			fixedWidth: size.width,
			fixedHeight: size.height,
			style: notes.num(row, "style"),
		};
		out.push(item);
	}

	const drawings = new Table(db, "items_drawings");
	for (const row of drawings.rows) {
		const base = baseFor(row.rowid, "Drawing");
		if (!base) continue;
		let strokes: DrawingItem["strokes"] = [];
		try {
			const parsed = parseStrokesCell(drawings.bin(row, "strokes"));
			if (parsed) {
				strokes = parsed.strokes;
				if (parsed.consumed !== parsed.total) {
					warnings.push(
						`Drawing ${base.id}: stroke data has ${parsed.total - parsed.consumed} unread byte(s).`,
					);
				}
			}
		} catch (e) {
			warnings.push(`Drawing ${base.id}: unreadable strokes (${msg(e)}).`);
		}
		const item: DrawingItem = { ...base, kind: "drawing", strokes };
		out.push(item);
	}

	const groups = new Table(db, "items_groups");
	for (const row of groups.rows) {
		const base = baseFor(row.rowid, "Group");
		if (!base) continue;
		const item: GroupItem = {
			...base,
			kind: "group",
			backgroundColor: emptyToNull(groups.str(row, "background_color")),
			lockMode: groups.num(row, "lock_mode"),
		};
		out.push(item);
	}

	for (const id of bases.keys()) {
		if (!typed.has(id)) warnings.push(`Item ${id} has no known subtype (image/note/drawing/group); skipped.`);
	}

	out.sort((a, b) => a.z - b.z || a.sortOrder - b.sortOrder || a.id - b.id);
	return out;
}

function readMetadata(db: SqliteDatabase, warnings: string[]): BoardMetadata | null {
	const t = new Table(db, "metadata");
	const row = t.rows[0];
	if (!row) return null;
	let sceneRect = null;
	let viewTransform = null;
	try {
		sceneRect = parseRectFCell(t.bin(row, "scene_rect"));
	} catch (e) {
		warnings.push(`Metadata: unreadable scene rect (${msg(e)}).`);
	}
	try {
		viewTransform = parseTransformCell(t.bin(row, "view_transform"));
	} catch (e) {
		warnings.push(`Metadata: unreadable view transform (${msg(e)}).`);
	}
	return {
		sceneRect,
		viewTransform,
		applicationVersion: t.str(row, "application_version"),
		horizontalScroll: t.num(row, "horizontal_scroll"),
		verticalScroll: t.num(row, "vertical_scroll"),
		lastSavePath: t.str(row, "last_save_path"),
		lastLoadPath: t.str(row, "last_load_path"),
		thumbnail: t.blob(row, "thumbnail"),
	};
}

function fullRectPath(w: number, h: number): PainterPath {
	const x0 = -w / 2;
	const y0 = -h / 2;
	return {
		elements: [
			{ type: 0, x: x0, y: y0 },
			{ type: 1, x: x0 + w, y: y0 },
			{ type: 1, x: x0 + w, y: y0 + h },
			{ type: 1, x: x0, y: y0 + h },
			{ type: 1, x: x0, y: y0 },
		],
		subpathStart: 0,
		fillRule: 0,
	};
}

function emptyToNull(s: string | null): string | null {
	return s === null || s.trim() === "" ? null : s;
}

function clamp01(n: number): number {
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export { PurReadError };
