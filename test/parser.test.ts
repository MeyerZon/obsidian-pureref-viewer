import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { boardStaticBounds, imageItemRect } from "../src/pur/bounds.ts";
import type { DrawingItem, ImageItem, NoteItem } from "../src/pur/model.ts";
import { parseHeader, parsePur, reconstructDatabase } from "../src/pur/parser.ts";
import { isAxisAlignedRectPath, painterPathToSvg } from "../src/pur/qt.ts";
import { SqliteDatabase, parseCreateTable } from "../src/pur/sqlite.ts";
import { apply, decompose, invert, mul, toCssMatrix, type Matrix } from "../src/pur/transform.ts";
import { readVarint } from "../src/pur/bytes.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = process.env.PUR_FIXTURE ?? path.join(repoRoot, "UI Explorations.pur");
const haveFixture = existsSync(fixturePath);
const fixture = (): Uint8Array => new Uint8Array(readFileSync(fixturePath));
const md5 = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");
const near = (a: number, b: number, eps = 1e-3): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearMatrix = (a: Matrix, b: Matrix, eps = 1e-3): void => {
	for (let i = 0; i < 9; i++) near(a[i] as number, b[i] as number, eps);
};

// ---- Pure unit tests (no fixture needed) --------------------------------------------------------

test("varint decodes 1, 2 and 9 byte values", () => {
	assert.deepEqual(readVarint(new Uint8Array([0x7f]), 0), { value: 127n, length: 1 });
	assert.deepEqual(readVarint(new Uint8Array([0x81, 0x00]), 0), { value: 128n, length: 2 });
	const nine = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
	assert.deepEqual(readVarint(nine, 0), { value: (1n << 64n) - 1n, length: 9 });
});

test("CREATE TABLE parsing finds columns and the rowid alias", () => {
	const parsed = parseCreateTable(
		"CREATE TABLE items(parent INTEGER, id INTEGER PRIMARY KEY, name TEXT, transform BLOB, z REAL)",
	);
	assert.deepEqual(parsed.columns, ["parent", "id", "name", "transform", "z"]);
	assert.equal(parsed.rowidAlias, 1);
	assert.equal(parseCreateTable("CREATE TABLE t(a INTEGER PRIMARY KEY DESC, b TEXT)").rowidAlias, -1);
	assert.equal(parseCreateTable("CREATE TABLE t(a INTEGER PRIMARY KEY, b) WITHOUT ROWID").rowidAlias, -1);
});

test("matrix composition follows Qt row-vector order", () => {
	const t: Matrix = [1, 0, 0, 0, 1, 0, 10, 20, 1];
	const s: Matrix = [2, 0, 0, 0, 2, 0, 0, 0, 1];
	// translate then scale: (0,0) -> (10,20) -> (20,40)
	const p = apply(mul(t, s), 0, 0);
	assert.deepEqual(p, { x: 20, y: 40 });
	// scale then translate: (0,0) -> (0,0) -> (10,20)
	assert.deepEqual(apply(mul(s, t), 0, 0), { x: 10, y: 20 });
	const inv = invert(mul(t, s));
	assert.ok(inv);
	const back = apply(inv, 20, 40);
	near(back.x, 0);
	near(back.y, 0);
	assert.equal(toCssMatrix(t), "matrix(1, 0, 0, 1, 10, 20)");
});

test("painter path to SVG turns cubic triples into C commands", () => {
	const d = painterPathToSvg({
		elements: [
			{ type: 0, x: 0, y: 0 },
			{ type: 2, x: 1, y: 1 },
			{ type: 3, x: 2, y: 2 },
			{ type: 3, x: 3, y: 3 },
			{ type: 1, x: 4, y: 4 },
		],
		subpathStart: 0,
		fillRule: 0,
	});
	assert.equal(d, "M0 0 C1 1 2 2 3 3 L4 4");
});

// ---- Fixture-driven tests ----------------------------------------------------------------------

test("header fields and checksum of the sample board", { skip: !haveFixture && `no fixture at ${fixturePath}` }, () => {
	const bytes = fixture();
	assert.equal(bytes.byteLength, 2_080_171);
	const header = parseHeader(bytes);
	assert.equal(header.formatVersion, "2.1");
	assert.equal(header.appVersion, "2.1.3");
	assert.equal(header.databaseLength, 2_068_480);
	assert.equal(header.headerLength, 11_691);
	assert.equal(header.checksum, "a55e18a16f2ceff163157b6b66328635");
	assert.equal(header.checksumStart, 104);
	assert.equal(header.thumbnail?.byteLength, 11_583);
	assert.equal(md5(bytes.subarray(header.checksumStart)), header.checksum);
});

test("database reconstruction and SQLite schema", { skip: !haveFixture }, () => {
	const bytes = fixture();
	const header = parseHeader(bytes);
	const db = new SqliteDatabase(reconstructDatabase(bytes, header, []));
	assert.equal(db.pageSize, 4096);
	assert.equal(db.pageCount, 505);
	assert.equal(db.applicationId, 940753918);
	assert.equal(db.userVersion, 200101);
	assert.deepEqual(
		[...db.tables.keys()].sort(),
		["images", "items", "items_drawings", "items_groups", "items_images", "items_notes", "metadata"],
	);
	assert.deepEqual(db.tables.get("images")?.columns, [
		"id",
		"source_type",
		"origin",
		"source",
		"format",
		"checksum",
		"data",
		"width",
		"height",
	]);
	assert.equal(db.readTable("items_groups").length, 0);
	assert.equal(db.warnings.length, 0);
});

test("images: 12 embedded PNGs whose MD5 matches the stored checksum", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	assert.equal(board.images.size, 12);
	for (const img of board.images.values()) {
		assert.equal(img.sourceType, 1);
		assert.equal(img.mime, "image/png");
		assert.ok(img.data, `image ${img.id} has data`);
		assert.equal(md5(img.data), img.checksum, `image ${img.id} checksum`);
		assert.ok(img.origin?.startsWith("C:/Users/"), "origin is a Windows path");
	}
	const first = board.images.get(0);
	assert.equal(first?.width, 1156);
	assert.equal(first?.height, 687);
	assert.equal(first?.data?.byteLength, 94_563);
});

test("items: counts, ids, transforms and parent composition", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	const byKind = (k: string) => board.items.filter((i) => i.kind === k);
	assert.equal(board.items.length, 36);
	assert.equal(byKind("image").length, 12);
	assert.equal(byKind("note").length, 14);
	assert.equal(byKind("drawing").length, 10);
	assert.equal(byKind("group").length, 0);
	for (const it of board.items) assert.ok(Number.isInteger(it.id) && it.id >= 0, "rowid resolved");

	const item = (id: number) => {
		const it = board.items.find((i) => i.id === id);
		assert.ok(it, `item ${id}`);
		return it;
	};
	const i0 = item(0) as ImageItem;
	assert.equal(i0.kind, "image");
	assert.equal(i0.parentId, -1);
	nearMatrix(i0.world, [3.1362, 0, 0, 0, 3.1362, 0, -6058.7267, 96.0276, 1], 1e-3);
	nearMatrix(mul(i0.imageTransform, i0.world), [3.1362, 0, 0, 0, 3.1362, 0, -7871.47, -981.27, 1], 0.02);
	near(apply(mul(i0.imageTransform, i0.world), 0, 0).x, -7871.47, 0.1);

	// Children compose child-then-parent (reversed order would give -21813 / 9834).
	const i16 = item(16);
	assert.equal(i16.parentId, 0);
	nearMatrix(i16.world, [11.0121, 0, 0, 0, 11.0121, 0, -7751.4381, 1112.7326, 1], 1e-2);
	const i38 = item(38);
	near(i38.world[6], -82.3236, 1e-2);
	near(i38.world[7], 782.0741, 1e-2);

	const i8 = item(8) as ImageItem;
	near((decompose(i8.world).rotation * 180) / Math.PI, 0.45, 0.01);

	// Paint order ascending z.
	for (let i = 1; i < board.items.length; i++) {
		assert.ok((board.items[i - 1] as ImageItem).z <= (board.items[i] as ImageItem).z);
	}
});

test("image items: bounds are uncropped full rects and image transforms are centred", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	for (const it of board.items) {
		if (it.kind !== "image") continue;
		const img = board.images.get(it.imageId);
		assert.ok(img);
		assert.ok(isAxisAlignedRectPath(it.bounds), `item ${it.id} bounds is a rect path`);
		assert.deepEqual(it.boundsRect, { x: -img.width / 2, y: -img.height / 2, width: img.width, height: img.height });
		nearMatrix(it.imageTransform, [1, 0, 0, 0, 1, 0, -img.width / 2, -img.height / 2, 1], 1e-9);
		assert.equal(it.flags, 1);
		assert.equal(it.playbackState, 0);
		const rect = imageItemRect(it);
		assert.ok(rect.width > 0 && rect.height > 0);
	}
	const bounds = boardStaticBounds(board);
	assert.ok(bounds);
	assert.ok(bounds.x < -7000 && bounds.width > 10_000, `content bounds look plausible: ${JSON.stringify(bounds)}`);
});

test("notes: rich text and sizing", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	const notes = board.items.filter((i): i is NoteItem => i.kind === "note");
	const texts = notes.map((n) => n.html);
	assert.ok(texts.some((t) => t.includes("UI Exploration Board")));
	assert.ok(texts.some((t) => t.includes("Gamblers Table")));
	assert.ok(texts.every((t) => t.includes("<html")));
	assert.ok(notes.every((n) => n.style === 0 && n.textColor === null && n.backgroundColor === null));
	assert.ok(notes.some((n) => n.fixedWidth === -1));
	assert.ok(notes.some((n) => n.fixedWidth > 0 && n.fixedHeight === -1));
});

test("drawings: strokes parse byte-exact", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	const drawings = board.items.filter((i): i is DrawingItem => i.kind === "drawing");
	assert.equal(drawings.length, 10);
	assert.ok(!board.warnings.some((w) => w.includes("unread byte")), board.warnings.join("\n"));
	let strokeCount = 0;
	for (const d of drawings) {
		for (const s of d.strokes) {
			strokeCount++;
			assert.equal(s.style, 0);
			assert.ok(s.width > 0);
			assert.ok(s.color.a > 0.5 && s.color.a <= 1);
			const n = s.path.elements.length;
			assert.ok(n === 0 || (n - 1) % 3 === 0, `element count ${n} is 1+3k`);
		}
	}
	assert.ok(strokeCount > 0);
});

test("metadata: view transform and scroll", { skip: !haveFixture }, () => {
	const board = parsePur(fixture());
	assert.ok(board.metadata);
	assert.equal(board.metadata.applicationVersion, "2.1.3");
	near(board.metadata.viewTransform?.[0] ?? 0, 0.026732, 1e-5);
	assert.equal(board.metadata.horizontalScroll, -494);
	assert.equal(board.metadata.verticalScroll, -109);
	near(board.metadata.sceneRect?.x ?? 0, -17468.79, 0.01);
	assert.equal(board.metadata.thumbnail?.byteLength, 11_583);
	assert.equal(board.thumbnail?.byteLength, 11_583);
	// The only expected warning is the checksum notice.
	assert.deepEqual(
		board.warnings.filter((w) => !w.startsWith("File checksum was not verified")),
		[],
	);
});

test("corrupt input: truncated file fails cleanly, 1.x is rejected", { skip: !haveFixture }, () => {
	const bytes = fixture();
	assert.throws(() => parsePur(bytes.subarray(0, 50_000)), /SQLite|corrupt|Corrupt/i);
	const fake = new Uint8Array([0, 0, 0, 6, 0, 0x31, 0, 0x2e, 0, 0x30, 0, 0, 0, 0]);
	assert.throws(() => parsePur(fake), /PureRef 1\.0 files are not supported/);
});
