import { Notice, TFile, TFolder, normalizePath, type App } from "obsidian";
import type { Board, ImageResource } from "../pur/model.ts";
import { parsePur } from "../pur/parser.ts";

export interface ExportResult {
	written: number;
	skipped: number;
	linked: number;
	folder: string;
}

/** Writes every embedded image of a board into a folder next to the board file. */
export async function exportBoardImages(
	app: App,
	file: TFile,
	folderTemplate: string,
	board?: Board | null,
): Promise<ExportResult | null> {
	let parsed = board ?? null;
	if (!parsed) {
		try {
			parsed = parsePur(await app.vault.readBinary(file));
		} catch (e) {
			new Notice(`Could not read ${file.name}: ${describe(e)}`);
			return null;
		}
	}
	const folder = await resolveExportFolder(app, file, folderTemplate);
	if (!folder) return null;

	const images = [...parsed.images.values()].sort((a, b) => a.id - b.id);
	const result: ExportResult = { written: 0, skipped: 0, linked: 0, folder };
	const used = new Set<string>();
	let index = 0;
	for (const img of images) {
		if (!img.data || img.data.byteLength === 0) {
			result.linked++;
			continue;
		}
		index++;
		const outcome = await writeImage(app, folder, img, `${String(index).padStart(2, "0")}-${imageBaseName(img)}`, used);
		if (outcome.status === "written") result.written++;
		else result.skipped++;
	}

	const parts = [`Exported ${result.written} image${result.written === 1 ? "" : "s"} to "${folder}".`];
	if (result.skipped) parts.push(`${result.skipped} already existed.`);
	if (result.linked) parts.push(`${result.linked} linked image${result.linked === 1 ? " was" : "s were"} not embedded.`);
	new Notice(parts.join(" "));
	return result;
}

/** Writes one embedded image into the board's export folder; returns its vault path or null. */
export async function exportSingleImage(
	app: App,
	file: TFile,
	folderTemplate: string,
	img: ImageResource,
): Promise<string | null> {
	if (!img.data || img.data.byteLength === 0) {
		new Notice("This image is linked rather than embedded, so there is nothing to save.");
		return null;
	}
	const folder = await resolveExportFolder(app, file, folderTemplate);
	if (!folder) return null;
	const outcome = await writeImage(app, folder, img, imageBaseName(img), new Set());
	if (outcome.status === "written") new Notice(`Saved image to "${outcome.path}".`);
	else if (outcome.status === "exists") new Notice(`Image is already in the vault: "${outcome.path}".`);
	return outcome.path;
}

/** Resolves (and creates if needed) the export folder next to the board. Null when it cannot be created. */
export async function resolveExportFolder(app: App, file: TFile, folderTemplate: string): Promise<string | null> {
	const folderName =
		sanitizeName(folderTemplate.replace(/\{\{\s*board\s*\}\}/gi, file.basename)) || `${file.basename} images`;
	const parent = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
	const folder = normalizePath(`${parent}${folderName}`);
	try {
		await app.vault.createFolder(folder);
	} catch {
		// Folder already exists (or cannot be created; the check below reports that).
	}
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
		new Notice(`Could not create the folder "${folder}".`);
		return null;
	}
	return folder;
}

interface WriteOutcome {
	status: "written" | "exists" | "failed";
	path: string | null;
}

async function writeImage(
	app: App,
	folder: string,
	img: ImageResource,
	baseName: string,
	used: Set<string>,
): Promise<WriteOutcome> {
	const data = img.data as Uint8Array;
	const target = uniquePath(app, folder, baseName, img.extension, data.byteLength, used);
	if (target.status === "exists") return { status: "exists", path: target.path };
	if (target.status === "failed") return { status: "failed", path: null };
	try {
		await app.vault.createBinary(target.path, data.slice().buffer);
		return { status: "written", path: target.path };
	} catch (e) {
		new Notice(`Could not write ${target.path}: ${describe(e)}`);
		return { status: "failed", path: null };
	}
}

/**
 * Picks a path for an image: reports an identical existing file as "exists",
 * otherwise appends a counter until the name is free.
 */
function uniquePath(
	app: App,
	folder: string,
	base: string,
	ext: string,
	size: number,
	used: Set<string>,
): { status: "free" | "exists"; path: string } | { status: "failed" } {
	for (let n = 0; n < 1000; n++) {
		const name = n === 0 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
		const path = normalizePath(`${folder}/${name}`);
		if (used.has(path)) continue;
		const existing = app.vault.getAbstractFileByPath(path);
		if (!existing) {
			used.add(path);
			return { status: "free", path };
		}
		if (existing instanceof TFile && existing.stat.size === size) {
			used.add(path);
			return { status: "exists", path };
		}
	}
	return { status: "failed" };
}

export function imageBaseName(img: ImageResource): string {
	const source = img.origin ?? img.source ?? "";
	const last = source.split(/[\\/]/).pop() ?? "";
	const withoutQuery = last.split(/[?#]/)[0] ?? "";
	const withoutExt = withoutQuery.replace(/\.[a-z0-9]{1,5}$/i, "");
	const clean = sanitizeName(withoutExt);
	return clean || `image-${img.id}`;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeName(name: string): string {
	const clean = Array.from(name)
		.filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20)
		.join("")
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.replace(/^[.\s-]+|[.\s-]+$/g, "");
	return RESERVED_NAMES.test(clean) ? `${clean}-file` : clean;
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
