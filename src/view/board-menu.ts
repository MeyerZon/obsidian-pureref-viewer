import { Menu, type App, type TFile } from "obsidian";
import { exportSingleImage } from "../commands/export-images.ts";
import { imageCropRect, imageItemRect } from "../pur/bounds.ts";
import type { Board, ImageItem, Item, NoteItem } from "../pur/model.ts";
import { canCopyImages, copyImage, copyText } from "../util/clipboard.ts";
import { canOpenExternally, openInDefaultApp } from "../util/open-external.ts";
import type { BoardRenderer } from "./board-renderer.ts";
import { noteHtmlToMarkdown, noteHtmlToPlainText } from "./note-html.ts";

export interface BoardMenuContext {
	app: App;
	file: TFile;
	board: Board;
	renderer: BoardRenderer;
	exportFolderTemplate: string;
}

/** Right-click menu for the board canvas, an image item or a note item. */
export function showBoardContextMenu(evt: MouseEvent, item: Item | null, ctx: BoardMenuContext): void {
	evt.preventDefault();
	evt.stopPropagation();
	const menu = new Menu();
	if (item?.kind === "image") addImageItems(menu, item, ctx);
	else if (item?.kind === "note") addNoteItems(menu, item, evt);
	else addCanvasItems(menu, ctx);
	menu.showAtMouseEvent(evt);
}

function addImageItems(menu: Menu, item: ImageItem, ctx: BoardMenuContext): void {
	const res = ctx.board.images.get(item.imageId);
	const embedded = !!res?.data && res.data.byteLength > 0;
	const crop = res ? imageCropRect(item, res.width, res.height) : null;

	if (res && embedded && canCopyImages()) {
		menu.addItem((i) =>
			i
				.setTitle(crop ? "Copy image (cropped)" : "Copy image")
				.setIcon("copy")
				.onClick(() => void copyImage(res, crop)),
		);
		if (crop) {
			menu.addItem((i) =>
				i
					.setTitle("Copy full image")
					.setIcon("copy")
					.onClick(() => void copyImage(res, null)),
			);
		}
	}
	if (res && embedded) {
		menu.addItem((i) =>
			i
				.setTitle("Save image to vault")
				.setIcon("image-down")
				.onClick(() => void exportSingleImage(ctx.app, ctx.file, ctx.exportFolderTemplate, res)),
		);
	}
	const source = res?.origin ?? res?.source ?? null;
	if (source) {
		menu.addItem((i) =>
			i
				.setTitle("Copy image source path")
				.setIcon("link")
				.onClick(() => void copyText(source, "image path")),
		);
	}
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Fit image to view")
			.setIcon("maximize")
			.onClick(() => ctx.renderer.panzoom.fitRect(imageItemRect(item), 48, true)),
	);
}

function addNoteItems(menu: Menu, item: NoteItem, evt: MouseEvent): void {
	const noteEl = (evt.target as HTMLElement | null)?.closest?.(".pureref-note") ?? null;
	const selection = evt.view?.getSelection?.() ?? null;
	const selected = selection && !selection.isCollapsed ? selection.toString() : "";
	if (selected.trim() !== "" && noteEl && selection?.anchorNode && noteEl.contains(selection.anchorNode)) {
		menu.addItem((i) =>
			i
				.setTitle("Copy selection")
				.setIcon("copy")
				.onClick(() => void copyText(selected, "selection")),
		);
	}
	menu.addItem((i) =>
		i
			.setTitle("Copy text")
			.setIcon("copy")
			.onClick(() => void copyText(noteHtmlToPlainText(item.html), "note text")),
	);
	menu.addItem((i) =>
		i
			.setTitle("Copy as Markdown")
			.setIcon("file-text")
			.onClick(() => void copyText(noteHtmlToMarkdown(item.html), "note as Markdown")),
	);
}

function addCanvasItems(menu: Menu, ctx: BoardMenuContext): void {
	menu.addItem((i) =>
		i
			.setTitle("Fit board to view")
			.setIcon("maximize")
			.onClick(() => ctx.renderer.fitAll(true)),
	);
	menu.addItem((i) =>
		i
			.setTitle("Zoom to actual size")
			.setIcon("scan")
			.onClick(() => ctx.renderer.zoomActual(true)),
	);
	if (canOpenExternally(ctx.app)) {
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Open in PureRef")
				.setIcon("external-link")
				.onClick(() => void openInDefaultApp(ctx.app, ctx.file.path)),
		);
	}
}
