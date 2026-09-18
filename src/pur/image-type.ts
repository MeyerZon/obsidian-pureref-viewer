import { bytesStartWith } from "./bytes.ts";

export interface ImageType {
	mime: string;
	extension: string;
}

const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** Detects the image container from magic bytes; falls back to PureRef's format string. */
export function sniffImageType(bytes: Uint8Array | null, format: string | null): ImageType {
	if (bytes && bytes.byteLength >= 12) {
		if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
			return { mime: "image/png", extension: "png" };
		}
		if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: "jpg" };
		if (bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { mime: "image/gif", extension: "gif" };
		if (bytesStartWith(bytes, RIFF) && bytesStartWith(bytes, WEBP, 8)) {
			return { mime: "image/webp", extension: "webp" };
		}
		if (bytesStartWith(bytes, [0x42, 0x4d])) return { mime: "image/bmp", extension: "bmp" };
		if (bytesStartWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
			return { mime: "image/tiff", extension: "tif" };
		}
		if (bytesStartWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
			const brand = String.fromCharCode(...bytes.subarray(8, 12));
			if (brand.startsWith("avi")) return { mime: "image/avif", extension: "avif" };
			if (brand.startsWith("hei") || brand.startsWith("mif")) return { mime: "image/heif", extension: "heic" };
		}
		if (bytesStartWith(bytes, [0x3c]) || bytesStartWith(bytes, [0xef, 0xbb, 0xbf, 0x3c])) {
			return { mime: "image/svg+xml", extension: "svg" };
		}
	}
	return fromFormatString(format);
}

function fromFormatString(format: string | null): ImageType {
	const f = (format ?? "").trim().toLowerCase().replace(/^\./, "");
	switch (f) {
		case "jpg":
		case "jpeg":
			return { mime: "image/jpeg", extension: "jpg" };
		case "png":
			return { mime: "image/png", extension: "png" };
		case "gif":
			return { mime: "image/gif", extension: "gif" };
		case "webp":
			return { mime: "image/webp", extension: "webp" };
		case "bmp":
			return { mime: "image/bmp", extension: "bmp" };
		case "svg":
			return { mime: "image/svg+xml", extension: "svg" };
		case "tif":
		case "tiff":
			return { mime: "image/tiff", extension: "tif" };
		case "avif":
			return { mime: "image/avif", extension: "avif" };
		default:
			return { mime: "application/octet-stream", extension: f || "bin" };
	}
}
