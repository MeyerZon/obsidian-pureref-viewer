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
			new Notice(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	const folderName = sanitizeName(folderTemplate.replace(/\{\{\s*board\s*\}\}/gi, file.basename)) || `${file.basename} images`;
	const parent = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
	const folder = normalizePath(`${parent}${folderName}`);
	try {
		await app.vault.createFolder(folder);
	} catch {
		// Folder already exists (or cannot be created; createBinary below will report that).
	}
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
		new Notice(`Could not create the folder "${folder}".`);
		return null;
	}

	const images = [...parsed.images.values()].sort((a, b) => a.id - b.id);
	const result: ExportResult = { written: 0, skipped: 0, linked: 0, folder };
	const usedNames = new Set<string>();
	let index = 0;
	for (const img of images) {
		if (!img.data || img.data.byteLength === 0) {
			result.linked++;
			continue;
		}
		index++;
		const base = `${String(index).padStart(2, "0")}-${imageBaseName(img)}`;
		const target = await uniquePath(app, folder, base, img.extension, img.data.byteLength, usedNames);
		if (target === null) {
			result.skipped++;
			continue;
		}
		try {
			await app.vault.createBinary(target, img.data.slice().buffer);
			result.written++;
		} catch (e) {
			new Notice(`Could not write ${target}: ${e instanceof Error ? e.message : String(e)}`);
			result.skipped++;
		}
	}

	const parts = [`Exported ${result.written} image${result.written === 1 ? "" : "s"} to "${folder}".`];
	if (result.skipped) parts.push(`${result.skipped} already existed.`);
	if (result.linked) parts.push(`${result.linked} linked image${result.linked === 1 ? " was" : "s were"} not embedded.`);
	new Notice(parts.join(" "));
	return result;
}

/**
 * Picks a path for an image: reuses an identical existing file (returns null to skip),
 * otherwise appends a counter until the name is free.
 */
async function uniquePath(
	app: App,
	folder: string,
	base: string,
	ext: string,
	size: number,
	used: Set<string>,
): Promise<string | null> {
	for (let n = 0; n < 1000; n++) {
		const name = n === 0 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
		const path = normalizePath(`${folder}/${name}`);
		if (used.has(path)) continue;
		const existing = app.vault.getAbstractFileByPath(path);
		if (!existing) {
			used.add(path);
			return path;
		}
		if (existing instanceof TFile && existing.stat.size === size) {
			used.add(path);
			return null;
		}
	}
	return null;
}

function imageBaseName(img: ImageResource): string {
	const source = img.origin ?? img.source ?? "";
	const last = source.split(/[\\/]/).pop() ?? "";
	const withoutQuery = last.split(/[?#]/)[0] ?? "";
	const withoutExt = withoutQuery.replace(/\.[a-z0-9]{1,5}$/i, "");
	const clean = sanitizeName(withoutExt);
	return clean || `image-${img.id}`;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeName(name: string): string {
	const clean = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/[\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.replace(/^[.\s-]+|[.\s-]+$/g, "");
	return RESERVED_NAMES.test(clean) ? `${clean}-file` : clean;
}
