import { Notice } from "obsidian";
import type { ImageResource } from "../pur/model.ts";
import type { Rect } from "../pur/transform.ts";

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Copies plain text to the clipboard and reports the outcome with a Notice. */
export async function copyText(text: string, what = "text"): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(`Copied ${what}.`);
		return true;
	} catch (e) {
		new Notice(`Could not copy ${what}: ${describe(e)}`);
		return false;
	}
}

export function canCopyImages(): boolean {
	return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copies an embedded image to the clipboard as PNG (the only image type Chromium accepts).
 * PNG sources are copied byte-for-byte unless a crop is requested; other formats are re-encoded.
 */
export async function copyImage(res: ImageResource, crop: Rect | null = null): Promise<boolean> {
	if (!res.data || res.data.byteLength === 0) {
		new Notice("This image is linked rather than embedded, so there is nothing to copy.");
		return false;
	}
	if (!canCopyImages()) {
		new Notice("Copying images to the clipboard is not supported here.");
		return false;
	}
	try {
		let png: Blob;
		let suffix = crop ? " (cropped)" : "";
		if (res.mime === "image/png" && !crop) {
			png = new Blob([res.data as Uint8Array<ArrayBuffer>], { type: "image/png" });
		} else {
			png = await encodePng(res, crop);
			if (res.mime === "image/gif" || res.mime === "image/webp") suffix += " (first frame only)";
		}
		await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
		new Notice(`Copied image${suffix}.`);
		return true;
	} catch (e) {
		new Notice(`Could not copy image: ${describe(e)}`);
		return false;
	}
}

async function encodePng(res: ImageResource, crop: Rect | null): Promise<Blob> {
	const source = new Blob([res.data as Uint8Array<ArrayBuffer>], { type: res.mime });
	const bitmap = await createImageBitmap(source);
	try {
		const sx = crop ? Math.max(0, Math.round(crop.x)) : 0;
		const sy = crop ? Math.max(0, Math.round(crop.y)) : 0;
		const sw = crop ? Math.min(bitmap.width - sx, Math.max(1, Math.round(crop.width))) : bitmap.width;
		const sh = crop ? Math.min(bitmap.height - sy, Math.max(1, Math.round(crop.height))) : bitmap.height;
		if (typeof OffscreenCanvas === "function") {
			const canvas = new OffscreenCanvas(sw, sh);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2D canvas context");
			ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
			return await canvas.convertToBlob({ type: "image/png" });
		}
		const canvas = createEl("canvas");
		canvas.width = sw;
		canvas.height = sh;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2D canvas context");
		ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
		);
	} finally {
		bitmap.close();
	}
}
