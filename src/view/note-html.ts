/**
 * Converts the Qt rich-text HTML stored in PureRef notes into safe DOM.
 * Only a small whitelist of structure and inline styling survives; everything else is dropped.
 */

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE"]);
const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "HEAD", "META", "TITLE", "LINK", "IMG", "TABLE", "OBJECT", "IFRAME"]);

interface InlineStyle {
	fontSize: string | null;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	color: string | null;
}

export function renderNoteHtml(container: HTMLElement, html: string): void {
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, "text/html");
	} catch {
		container.createDiv({ cls: "pureref-note-p", text: html });
		return;
	}
	const body = doc.body;
	if (!body) return;
	let wroteBlock = false;
	for (const child of Array.from(body.childNodes)) {
		if (renderNode(container, child)) wroteBlock = true;
	}
	if (!wroteBlock && container.childNodes.length === 0) {
		const text = body.textContent?.trim() ?? "";
		if (text) container.createDiv({ cls: "pureref-note-p", text });
	}
}

/** Renders a node into `parent`; returns true if a block element was produced. */
function renderNode(parent: HTMLElement, node: Node): boolean {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent ?? "";
		if (text !== "") parent.appendText(text);
		return false;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return false;
	const el = node as Element;
	const tag = el.tagName.toUpperCase();
	if (SKIP_TAGS.has(tag)) return false;

	if (tag === "BR") {
		parent.createEl("br");
		return false;
	}
	if (tag === "UL" || tag === "OL") {
		const list = parent.createEl(tag === "UL" ? "ul" : "ol", { cls: "pureref-note-list" });
		for (const child of Array.from(el.childNodes)) renderNode(list, child);
		return true;
	}
	if (BLOCK_TAGS.has(tag)) {
		const block =
			tag === "LI"
				? parent.createEl("li", { cls: "pureref-note-li" })
				: parent.createDiv({ cls: tag.startsWith("H") ? "pureref-note-p pureref-note-heading" : "pureref-note-p" });
		const align = (el.getAttribute("align") ?? styleValue(el, "text-align") ?? "").toLowerCase();
		if (align === "center" || align === "right" || align === "justify") block.addClass(`pureref-align-${align}`);
		if (tag === "LI") {
			const cls = el.getAttribute("class") ?? "";
			if (/\bchecked\b/.test(cls) && !/\bunchecked\b/.test(cls)) block.addClass("pureref-li-checked");
			else if (/\bunchecked\b/.test(cls)) block.addClass("pureref-li-unchecked");
		}
		const inline = inlineStyleOf(el);
		const target = hasInlineStyle(inline) ? styledSpan(block, inline) : block;
		for (const child of Array.from(el.childNodes)) renderNode(target, child);
		return true;
	}

	// Inline element: span, b, i, u, s, a, font, em, strong...
	const inline = inlineStyleOf(el);
	if (tag === "B" || tag === "STRONG") inline.bold = true;
	if (tag === "I" || tag === "EM") inline.italic = true;
	if (tag === "U") inline.underline = true;
	if (tag === "S" || tag === "STRIKE" || tag === "DEL") inline.strike = true;
	const target = hasInlineStyle(inline) ? styledSpan(parent, inline) : parent;
	let block = false;
	for (const child of Array.from(el.childNodes)) {
		if (renderNode(target, child)) block = true;
	}
	return block;
}

function styledSpan(parent: HTMLElement, s: InlineStyle): HTMLElement {
	const span = parent.createSpan({ cls: "pureref-note-span" });
	if (s.bold) span.addClass("pureref-b");
	if (s.italic) span.addClass("pureref-i");
	if (s.underline) span.addClass("pureref-u");
	if (s.strike) span.addClass("pureref-s");
	const styles: Partial<CSSStyleDeclaration> = {};
	if (s.fontSize) styles.fontSize = s.fontSize;
	if (s.color) styles.color = s.color;
	if (s.fontSize || s.color) span.setCssStyles(styles);
	return span;
}

function hasInlineStyle(s: InlineStyle): boolean {
	return s.bold || s.italic || s.underline || s.strike || s.fontSize !== null || s.color !== null;
}

function inlineStyleOf(el: Element): InlineStyle {
	const out: InlineStyle = { fontSize: null, bold: false, italic: false, underline: false, strike: false, color: null };
	const size = styleValue(el, "font-size");
	if (size) {
		const m = /^(\d+(?:\.\d+)?)\s*(px|pt)$/i.exec(size);
		if (m) {
			const n = parseFloat(m[1] as string);
			const px = (m[2] as string).toLowerCase() === "pt" ? n * (4 / 3) : n;
			if (px > 0 && px < 2000) out.fontSize = `${Math.round(px * 100) / 100}px`;
		}
	}
	const weight = styleValue(el, "font-weight");
	if (weight) {
		const n = parseInt(weight, 10);
		out.bold = weight.toLowerCase() === "bold" || (Number.isFinite(n) && n >= 600);
	}
	const fontStyle = styleValue(el, "font-style");
	if (fontStyle && /italic|oblique/i.test(fontStyle)) out.italic = true;
	const deco = styleValue(el, "text-decoration");
	if (deco) {
		if (/underline/i.test(deco)) out.underline = true;
		if (/line-through/i.test(deco)) out.strike = true;
	}
	const color = styleValue(el, "color");
	if (color) {
		const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
		if (m) out.color = `#${m[1] as string}`;
	}
	return out;
}

function styleValue(el: Element, prop: string): string | null {
	const style = el.getAttribute("style");
	if (!style) return null;
	for (const decl of style.split(";")) {
		const i = decl.indexOf(":");
		if (i < 0) continue;
		if (decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim();
	}
	return null;
}

/** Plain-text preview of a note (single line), for tooltips and fallbacks. */
export function noteHtmlToText(html: string): string {
	try {
		const doc = new DOMParser().parseFromString(html, "text/html");
		return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
	} catch {
		return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	}
}

/** Paragraph-preserving plain text of a note. */
export function noteHtmlToPlainText(html: string): string {
	return serializeNote(html, false);
}

/** Markdown rendition of a note: paragraphs, bold/italic/strike, lists, checkboxes, large-text headings. */
export function noteHtmlToMarkdown(html: string): string {
	return serializeNote(html, true);
}

interface ListContext {
	ordered: boolean;
	index: number;
	indent: string;
}

function serializeNote(html: string, markdown: boolean): string {
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, "text/html");
	} catch {
		return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	}
	const body = doc.body;
	if (!body) return "";
	const bodySize = parseFontSize(styleValue(body, "font-size")) ?? 22;
	const lines: string[] = [];
	serializeBlocks(body, lines, markdown, bodySize, null);
	return lines
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function serializeBlocks(
	parent: Node,
	lines: string[],
	markdown: boolean,
	bodySize: number,
	list: ListContext | null,
): void {
	let pending = "";
	const flush = () => {
		if (pending.trim() !== "") lines.push(pending);
		pending = "";
	};
	for (const node of Array.from(parent.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) {
			pending += node.textContent ?? "";
			continue;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) continue;
		const el = node as Element;
		const tag = el.tagName.toUpperCase();
		if (SKIP_TAGS.has(tag)) continue;
		if (tag === "BR") {
			flush();
			lines.push("");
			continue;
		}
		if (tag === "UL" || tag === "OL") {
			flush();
			const ctx: ListContext = { ordered: tag === "OL", index: 0, indent: list ? `${list.indent}  ` : "" };
			for (const li of Array.from(el.children)) {
				if (li.tagName.toUpperCase() !== "LI") continue;
				ctx.index++;
				const cls = li.getAttribute("class") ?? "";
				let marker: string;
				if (ctx.ordered) marker = `${ctx.index}. `;
				else if (markdown && /\bchecked\b/.test(cls) && !/\bunchecked\b/.test(cls)) marker = "- [x] ";
				else if (markdown && /\bunchecked\b/.test(cls)) marker = "- [ ] ";
				else marker = markdown ? "- " : "• ";
				const text = inlineText(li, markdown, true);
				lines.push(`${ctx.indent}${marker}${text.trim()}`);
				for (const nested of Array.from(li.children)) {
					const t = nested.tagName.toUpperCase();
					if (t === "UL" || t === "OL") serializeBlocks(li, lines, markdown, bodySize, ctx);
				}
			}
			continue;
		}
		if (BLOCK_TAGS.has(tag)) {
			flush();
			let line = inlineText(el, markdown, false);
			if (markdown && (tag.startsWith("H") || isLargeParagraph(el, bodySize))) {
				line = `## ${line.trim()}`;
			}
			lines.push(line);
			continue;
		}
		pending += inlineText(el, markdown, false);
	}
	flush();
}

/** True when a paragraph's text is dominated by a font at least 1.8x the body size (a visual heading). */
function isLargeParagraph(p: Element, bodySize: number): boolean {
	const text = (p.textContent ?? "").trim();
	if (text === "") return false;
	let large = 0;
	for (const span of Array.from(p.querySelectorAll("span"))) {
		const size = parseFontSize(styleValue(span, "font-size"));
		if (size !== null && size >= bodySize * 1.8) large += (span.textContent ?? "").trim().length;
	}
	return large >= text.length * 0.6;
}

/** Inline content of an element; nested lists are skipped (handled by the block walker). */
function inlineText(el: Element, markdown: boolean, skipNestedLists: boolean): string {
	let out = "";
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? "";
			continue;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) continue;
		const child = node as Element;
		const tag = child.tagName.toUpperCase();
		if (SKIP_TAGS.has(tag)) continue;
		if (tag === "BR") {
			out += "\n";
			continue;
		}
		if (skipNestedLists && (tag === "UL" || tag === "OL")) continue;
		let inner = inlineText(child, markdown, skipNestedLists);
		if (markdown) {
			const s = inlineStyleOf(child);
			if (tag === "B" || tag === "STRONG") s.bold = true;
			if (tag === "I" || tag === "EM") s.italic = true;
			if (tag === "S" || tag === "STRIKE" || tag === "DEL") s.strike = true;
			if (s.bold) inner = wrap(inner, "**");
			if (s.italic) inner = wrap(inner, "*");
			if (s.strike) inner = wrap(inner, "~~");
		}
		out += inner;
	}
	return out;
}

function wrap(text: string, marker: string): string {
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
	if (!m || (m[2] ?? "") === "") return text;
	return `${m[1] ?? ""}${marker}${m[2] ?? ""}${marker}${m[3] ?? ""}`;
}

function parseFontSize(value: string | null): number | null {
	if (!value) return null;
	const m = /^(\d+(?:\.\d+)?)\s*(px|pt)$/i.exec(value.trim());
	if (!m) return null;
	const n = parseFloat(m[1] as string);
	return (m[2] as string).toLowerCase() === "pt" ? n * (4 / 3) : n;
}
