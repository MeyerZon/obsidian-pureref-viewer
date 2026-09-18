/**
 * Low-level big-endian byte reading helpers. Dependency-free (no DOM, no Node).
 */

export class PurReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PurReadError";
	}
}

export class ByteReader {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	pos: number;

	constructor(bytes: Uint8Array, pos = 0) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.pos = pos;
	}

	get length(): number {
		return this.bytes.byteLength;
	}

	get remaining(): number {
		return this.bytes.byteLength - this.pos;
	}

	private need(n: number): void {
		if (n < 0 || this.pos + n > this.bytes.byteLength) {
			throw new PurReadError(
				`Read past end of data: need ${n} byte(s) at offset ${this.pos}, only ${this.remaining} left`,
			);
		}
	}

	u8(): number {
		this.need(1);
		return this.view.getUint8(this.pos++);
	}

	i8(): number {
		this.need(1);
		return this.view.getInt8(this.pos++);
	}

	u16(): number {
		this.need(2);
		const v = this.view.getUint16(this.pos);
		this.pos += 2;
		return v;
	}

	i16(): number {
		this.need(2);
		const v = this.view.getInt16(this.pos);
		this.pos += 2;
		return v;
	}

	u32(): number {
		this.need(4);
		const v = this.view.getUint32(this.pos);
		this.pos += 4;
		return v;
	}

	i32(): number {
		this.need(4);
		const v = this.view.getInt32(this.pos);
		this.pos += 4;
		return v;
	}

	u64(): bigint {
		this.need(8);
		const v = this.view.getBigUint64(this.pos);
		this.pos += 8;
		return v;
	}

	f64(): number {
		this.need(8);
		const v = this.view.getFloat64(this.pos);
		this.pos += 8;
		return v;
	}

	/** Returns a view (not a copy) of the next n bytes. */
	bytesView(n: number): Uint8Array {
		this.need(n);
		const out = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}

	skip(n: number): void {
		this.need(n);
		this.pos += n;
	}
}

/** SQLite varint: up to 9 bytes, big-endian, 7 bits per byte except the 9th which carries all 8. */
export function readVarint(bytes: Uint8Array, pos: number): { value: bigint; length: number } {
	let value = 0n;
	for (let i = 0; i < 8; i++) {
		const b = bytes[pos + i];
		if (b === undefined) throw new PurReadError(`Varint runs past end of data at offset ${pos}`);
		value = (value << 7n) | BigInt(b & 0x7f);
		if ((b & 0x80) === 0) return { value, length: i + 1 };
	}
	const last = bytes[pos + 8];
	if (last === undefined) throw new PurReadError(`Varint runs past end of data at offset ${pos}`);
	value = (value << 8n) | BigInt(last);
	return { value, length: 9 };
}

export function toSafeNumber(v: bigint, what: string): number {
	if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
		throw new PurReadError(`${what} does not fit in a JavaScript number: ${v}`);
	}
	return Number(v);
}

/** Manual UTF-16BE decoder: does not strip a leading BOM (unlike TextDecoder). */
export function decodeUtf16BE(bytes: Uint8Array): string {
	if (bytes.byteLength % 2 !== 0) {
		throw new PurReadError(`UTF-16 data has odd byte length ${bytes.byteLength}`);
	}
	const units = new Array<number>(bytes.byteLength / 2);
	for (let i = 0, j = 0; i < bytes.byteLength; i += 2, j++) {
		units[j] = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
	}
	let out = "";
	const CHUNK = 8192;
	for (let i = 0; i < units.length; i += CHUNK) {
		out += String.fromCharCode(...units.slice(i, i + CHUNK));
	}
	return out;
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Loose = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Decodes UTF-8 strictly; throws PurReadError on malformed input. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
	try {
		return utf8Fatal.decode(bytes);
	} catch (e) {
		throw new PurReadError(`Malformed UTF-8 text: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function decodeUtf8Loose(bytes: Uint8Array): string {
	return utf8Loose.decode(bytes);
}

export function bytesStartWith(bytes: Uint8Array, prefix: ArrayLike<number>, offset = 0): boolean {
	if (offset + prefix.length > bytes.byteLength) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (bytes[offset + i] !== prefix[i]) return false;
	}
	return true;
}

export function asciiBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.byteLength;
	}
	return out;
}
