/**
 * 2D affine math using Qt's QTransform layout and row-vector convention:
 *   x' = m11*x + m21*y + m31
 *   y' = m12*x + m22*y + m32
 * A Matrix is [m11, m12, m13, m21, m22, m23, m31, m32, m33].
 */

export type Matrix = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function isAffine(m: Matrix): boolean {
	return m[2] === 0 && m[5] === 0 && m[8] === 1;
}

/** Full 3x3 product a·b: the transform that applies `a` first, then `b`. */
export function mul(a: Matrix, b: Matrix): Matrix {
	const out: number[] = new Array<number>(9);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			out[r * 3 + c] =
				(a[r * 3] as number) * (b[c] as number) +
				(a[r * 3 + 1] as number) * (b[3 + c] as number) +
				(a[r * 3 + 2] as number) * (b[6 + c] as number);
		}
	}
	return out as unknown as Matrix;
}

export function translation(tx: number, ty: number): Matrix {
	return [1, 0, 0, 0, 1, 0, tx, ty, 1];
}

export function scaling(sx: number, sy = sx): Matrix {
	return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

export function apply(m: Matrix, x: number, y: number): Point {
	const w = m[2] * x + m[5] * y + m[8];
	const px = m[0] * x + m[3] * y + m[6];
	const py = m[1] * x + m[4] * y + m[7];
	if (w !== 1 && w !== 0) return { x: px / w, y: py / w };
	return { x: px, y: py };
}

/** Inverse of an affine matrix, or null when singular. */
export function invert(m: Matrix): Matrix | null {
	const a = m[0];
	const b = m[1];
	const c = m[3];
	const d = m[4];
	const e = m[6];
	const f = m[7];
	const det = a * d - b * c;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
	const ia = d / det;
	const ib = -b / det;
	const ic = -c / det;
	const id = a / det;
	const ie = -(e * ia + f * ic);
	const iff = -(e * ib + f * id);
	return [ia, ib, 0, ic, id, 0, ie, iff, 1];
}

export interface Decomposed {
	scaleX: number;
	scaleY: number;
	/** Radians, clockwise-positive in a y-down coordinate system. */
	rotation: number;
	tx: number;
	ty: number;
}

export function decompose(m: Matrix): Decomposed {
	return {
		scaleX: Math.hypot(m[0], m[1]),
		scaleY: Math.hypot(m[3], m[4]),
		rotation: Math.atan2(m[1], m[0]),
		tx: m[6],
		ty: m[7],
	};
}

/** CSS `matrix(a, b, c, d, e, f)` where x' = a*x + c*y + e and y' = b*x + d*y + f. */
export function toCssMatrix(m: Matrix): string {
	return `matrix(${fmt(m[0])}, ${fmt(m[1])}, ${fmt(m[3])}, ${fmt(m[4])}, ${fmt(m[6])}, ${fmt(m[7])})`;
}

/** Formats a number for CSS without exponent notation. */
export function fmt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (Math.abs(n) < 1e-9) return "0";
	return n.toFixed(6).replace(/\.?0+$/, "");
}

export function boundsOfPoints(points: Iterable<Point>): Rect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	if (minX === Infinity) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectCorners(r: Rect): Point[] {
	return [
		{ x: r.x, y: r.y },
		{ x: r.x + r.width, y: r.y },
		{ x: r.x + r.width, y: r.y + r.height },
		{ x: r.x, y: r.y + r.height },
	];
}

/** Axis-aligned bounding box of a rect after transformation. */
export function transformRect(m: Matrix, r: Rect): Rect {
	return boundsOfPoints(rectCorners(r).map((p) => apply(m, p.x, p.y))) as Rect;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

export function inflateRect(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}
