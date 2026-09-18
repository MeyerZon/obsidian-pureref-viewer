/**
 * Minimal read-only SQLite 3 table reader: enough to walk rowid table b-trees
 * (interior + leaf pages, overflow chains) and decode records.
 * Reference: https://www.sqlite.org/fileformat.html
 */
import { PurReadError, bytesStartWith, decodeUtf8Loose, decodeUtf8Strict, readVarint, toSafeNumber } from "./bytes.ts";

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlRow {
	rowid: number;
	values: SqlValue[];
}

export interface SqlTable {
	name: string;
	rootPage: number;
	sql: string;
	columns: string[];
	/** Index of the column that aliases the rowid (`INTEGER PRIMARY KEY`), or -1. */
	rowidAlias: number;
}

// "SQLite format 3\0"
const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
const PAGE_TABLE_INTERIOR = 0x05;
const PAGE_TABLE_LEAF = 0x0d;
const MAX_DEPTH = 64;

export function isSqliteDatabase(bytes: Uint8Array, offset = 0): boolean {
	return bytesStartWith(bytes, SQLITE_MAGIC, offset);
}

/** Finds the first occurrence of the SQLite magic string, or -1. */
export function findSqliteMagic(bytes: Uint8Array): number {
	const first = SQLITE_MAGIC[0] as number;
	for (let i = 0; i <= bytes.byteLength - SQLITE_MAGIC.length; i++) {
		if (bytes[i] === first && bytesStartWith(bytes, SQLITE_MAGIC, i)) return i;
	}
	return -1;
}

export class SqliteDatabase {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	readonly pageSize: number;
	readonly usableSize: number;
	readonly pageCount: number;
	readonly tables = new Map<string, SqlTable>();
	readonly warnings: string[] = [];

	constructor(bytes: Uint8Array) {
		if (!isSqliteDatabase(bytes)) throw new PurReadError("Not an SQLite database (bad magic)");
		if (bytes.byteLength < 100) throw new PurReadError("SQLite database is truncated");
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const rawPageSize = this.view.getUint16(16);
		this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
		if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) {
			throw new PurReadError(`Invalid SQLite page size ${this.pageSize}`);
		}
		const reserved = this.view.getUint8(20);
		this.usableSize = this.pageSize - reserved;
		if (this.usableSize < 480) throw new PurReadError("Invalid SQLite usable page size");
		const encoding = this.view.getUint32(56);
		if (encoding !== 1) throw new PurReadError(`Unsupported SQLite text encoding ${encoding} (expected UTF-8)`);
		const headerPageCount = this.view.getUint32(28);
		const derived = Math.floor(bytes.byteLength / this.pageSize);
		this.pageCount = headerPageCount > 0 && headerPageCount <= derived ? headerPageCount : derived;
		this.loadSchema();
	}

	get userVersion(): number {
		return this.view.getUint32(60);
	}

	get applicationId(): number {
		return this.view.getUint32(68);
	}

	private loadSchema(): void {
		for (const row of this.readRowsFromRoot(1)) {
			const [type, name, , rootPage, sql] = row.values;
			if (type !== "table" || typeof name !== "string" || typeof sql !== "string") continue;
			const root = typeof rootPage === "number" ? rootPage : typeof rootPage === "bigint" ? Number(rootPage) : 0;
			if (root <= 0) continue;
			const parsed = parseCreateTable(sql);
			this.tables.set(name, { name, rootPage: root, sql, columns: parsed.columns, rowidAlias: parsed.rowidAlias });
		}
	}

	hasTable(name: string): boolean {
		return this.tables.has(name);
	}

	/** Reads all rows of a table; the rowid alias column (if any) is filled from the rowid. */
	readTable(name: string): SqlRow[] {
		const table = this.tables.get(name);
		if (!table) return [];
		const rows = this.readRowsFromRoot(table.rootPage);
		for (const row of rows) {
			// Records may have fewer values than columns (ALTER TABLE ADD COLUMN); pad with NULL.
			while (row.values.length < table.columns.length) row.values.push(null);
			if (table.rowidAlias >= 0 && row.values[table.rowidAlias] === null) {
				row.values[table.rowidAlias] = row.rowid;
			}
		}
		return rows;
	}

	private readRowsFromRoot(rootPage: number): SqlRow[] {
		const out: SqlRow[] = [];
		this.walk(rootPage, out, new Set<number>(), 0);
		return out;
	}

	private pageOffset(page: number): number {
		if (page < 1 || page > this.pageCount) throw new PurReadError(`Page ${page} is out of range (1..${this.pageCount})`);
		return (page - 1) * this.pageSize;
	}

	private walk(page: number, out: SqlRow[], visited: Set<number>, depth: number): void {
		if (visited.has(page)) throw new PurReadError(`Cycle in b-tree at page ${page}`);
		if (depth > MAX_DEPTH) throw new PurReadError("B-tree is too deep");
		visited.add(page);
		const base = this.pageOffset(page);
		const hdr = base + (page === 1 ? 100 : 0);
		const type = this.view.getUint8(hdr);
		const cellCount = this.view.getUint16(hdr + 3);
		if (type === PAGE_TABLE_INTERIOR) {
			const ptrs = hdr + 12;
			for (let i = 0; i < cellCount; i++) {
				const cell = base + this.view.getUint16(ptrs + i * 2);
				const child = this.view.getUint32(cell);
				this.walk(child, out, visited, depth + 1);
			}
			const rightMost = this.view.getUint32(hdr + 8);
			this.walk(rightMost, out, visited, depth + 1);
		} else if (type === PAGE_TABLE_LEAF) {
			const ptrs = hdr + 8;
			for (let i = 0; i < cellCount; i++) {
				const cell = base + this.view.getUint16(ptrs + i * 2);
				try {
					out.push(this.readLeafCell(cell));
				} catch (e) {
					this.warnings.push(
						`Skipped a damaged row on page ${page}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
		} else {
			throw new PurReadError(`Page ${page} is not a table b-tree page (type 0x${type.toString(16)})`);
		}
	}

	private readLeafCell(cellStart: number): SqlRow {
		const bytes = this.bytes;
		const size = readVarint(bytes, cellStart);
		const payloadSize = toSafeNumber(size.value, "Payload size");
		const rowidV = readVarint(bytes, cellStart + size.length);
		const rowid = toSafeNumber(rowidV.value, "Rowid");
		const dataStart = cellStart + size.length + rowidV.length;
		const payload = this.readPayload(dataStart, payloadSize);
		return { rowid, values: decodeRecord(payload) };
	}

	/** Assembles a cell payload, following the overflow chain when needed. */
	private readPayload(dataStart: number, payloadSize: number): Uint8Array {
		const u = this.usableSize;
		const x = u - 35;
		if (payloadSize <= x) {
			return this.bytes.subarray(dataStart, dataStart + payloadSize);
		}
		const m = Math.floor(((u - 12) * 32) / 255) - 23;
		const k = m + ((payloadSize - m) % (u - 4));
		const local = k <= x ? k : m;
		const out = new Uint8Array(payloadSize);
		out.set(this.bytes.subarray(dataStart, dataStart + local), 0);
		let written = local;
		let next = this.view.getUint32(dataStart + local);
		const seen = new Set<number>();
		while (written < payloadSize) {
			if (next === 0) throw new PurReadError("Overflow chain ended early");
			if (seen.has(next)) throw new PurReadError("Cycle in overflow chain");
			seen.add(next);
			const off = this.pageOffset(next);
			const chunk = Math.min(u - 4, payloadSize - written);
			out.set(this.bytes.subarray(off + 4, off + 4 + chunk), written);
			written += chunk;
			next = this.view.getUint32(off);
		}
		return out;
	}
}

function decodeRecord(payload: Uint8Array): SqlValue[] {
	const header = readVarint(payload, 0);
	const headerSize = toSafeNumber(header.value, "Record header size");
	if (headerSize > payload.byteLength) throw new PurReadError("Record header exceeds payload");
	const serialTypes: bigint[] = [];
	let p = header.length;
	while (p < headerSize) {
		const t = readVarint(payload, p);
		serialTypes.push(t.value);
		p += t.length;
	}
	const values: SqlValue[] = [];
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	let body = headerSize;
	for (const st of serialTypes) {
		const t = Number(st);
		switch (t) {
			case 0:
				values.push(null);
				break;
			case 1:
				values.push(view.getInt8(body));
				body += 1;
				break;
			case 2:
				values.push(view.getInt16(body));
				body += 2;
				break;
			case 3: {
				const v = (view.getInt8(body) << 16) | view.getUint16(body + 1);
				values.push(v);
				body += 3;
				break;
			}
			case 4:
				values.push(view.getInt32(body));
				body += 4;
				break;
			case 5: {
				const hi = view.getInt16(body);
				const lo = view.getUint32(body + 2);
				values.push(hi * 4294967296 + lo);
				body += 6;
				break;
			}
			case 6: {
				const v = view.getBigInt64(body);
				values.push(
					v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v,
				);
				body += 8;
				break;
			}
			case 7:
				values.push(view.getFloat64(body));
				body += 8;
				break;
			case 8:
				values.push(0);
				break;
			case 9:
				values.push(1);
				break;
			case 10:
			case 11:
				throw new PurReadError(`Reserved serial type ${t} in record`);
			default: {
				if (t < 12) throw new PurReadError(`Invalid serial type ${t}`);
				const isBlob = t % 2 === 0;
				const len = isBlob ? (t - 12) / 2 : (t - 13) / 2;
				if (body + len > payload.byteLength) throw new PurReadError("Record value exceeds payload");
				const slice = payload.subarray(body, body + len);
				if (isBlob) {
					values.push(slice);
				} else {
					try {
						values.push(decodeUtf8Strict(slice));
					} catch {
						values.push(decodeUtf8Loose(slice));
					}
				}
				body += len;
			}
		}
	}
	return values;
}

/** Extracts column names and the rowid-alias column from a CREATE TABLE statement. */
export function parseCreateTable(sql: string): { columns: string[]; rowidAlias: number } {
	const open = sql.indexOf("(");
	const close = sql.lastIndexOf(")");
	if (open < 0 || close < open) return { columns: [], rowidAlias: -1 };
	const inner = sql.slice(open + 1, close);
	const defs = splitTopLevel(inner);
	const columns: string[] = [];
	let rowidAlias = -1;
	const withoutRowid = /\)\s*WITHOUT\s+ROWID/i.test(sql.slice(close));
	for (const rawDef of defs) {
		const def = rawDef.trim();
		if (def === "") continue;
		if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(def)) continue;
		const m = /^("([^"]*)"|`([^`]*)`|\[([^\]]*)\]|(\S+))/.exec(def);
		if (!m) continue;
		const name = m[2] ?? m[3] ?? m[4] ?? (m[5] as string);
		const rest = def.slice(m[0].length).trim();
		const index = columns.length;
		columns.push(name);
		if (!withoutRowid && /^INTEGER\s+PRIMARY\s+KEY(\s+ASC)?(\s+AUTOINCREMENT)?(\s+NOT\s+NULL)?\s*$/i.test(rest)) {
			rowidAlias = index;
		}
	}
	return { columns, rowidAlias };
}

function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	out.push(s.slice(start));
	return out;
}
