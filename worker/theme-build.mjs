// Build-time check for WORKER_THEME. The Worker inlines the result in a nonce'd style block and
// does not load a stylesheet, font, or image. Unsafe CSS is refused so the build stops.
import fs from "node:fs";
import path from "node:path";

const MAX = 16384;

function isHex(char) {
	return char !== undefined && ((char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F"));
}

function isCssSpace(char) {
	return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function isNewline(char) {
	return char === "\n" || char === "\r" || char === "\f";
}

function consumeNewline(css, i) {
	if (css[i] === "\r" && css[i + 1] === "\n") return i + 2;
	return i + 1;
}

/**
 * One CSS escape at a backslash. A backslash before a newline is not an escape (`newline`);
 * the caller decides whether that pair continues a string or stays in the sheet.
 * @param {string} css
 * @param {number} i index of the backslash
 */
function consumeEscape(css, i) {
	i++;
	if (i >= css.length) return { type: "char", char: "\uFFFD", next: i };
	if (isNewline(css[i])) return { type: "newline", next: i };
	if (isHex(css[i])) {
		let hex = "";
		while (hex.length < 6 && i < css.length && isHex(css[i])) hex += css[i++];
		if (i < css.length && isCssSpace(css[i])) i = isNewline(css[i]) ? consumeNewline(css, i) : i + 1;
		const codePoint = Number.parseInt(hex, 16);
		const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
		const char = codePoint === 0 || surrogate || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
		return { type: "char", char, next: i };
	}
	return { type: "char", char: css[i], next: i + 1 };
}

/**
 * Stylesheet text with escapes decoded, comments removed, and string contents removed.
 * Markers are recognized on the raw text, so a string cannot pretend to be a comment,
 * and a decoded character is not read again as a quote or a comment.
 * @param {string} css
 */
export function cssForChecks(css) {
	let out = "";
	let i = 0;
	/** @type {"normal" | "comment" | "string"} */
	let mode = "normal";
	let quote = "";
	while (i < css.length) {
		if (mode === "comment") {
			if (css[i] === "*" && css[i + 1] === "/") {
				mode = "normal";
				i += 2;
			} else i++;
			continue;
		}
		if (mode === "string") {
			if (css[i] === "\\") {
				const esc = consumeEscape(css, i);
				i = esc.type === "newline" ? consumeNewline(css, esc.next) : esc.next;
				continue;
			}
			if (isNewline(css[i])) {
				mode = "normal";
				out += "\n";
				i = consumeNewline(css, i);
				continue;
			}
			if (css[i] === quote) {
				mode = "normal";
				out += quote;
				i++;
				continue;
			}
			i++;
			continue;
		}
		if (css[i] === "/" && css[i + 1] === "*") {
			out += " ";
			mode = "comment";
			i += 2;
			continue;
		}
		if (css[i] === '"' || css[i] === "'") {
			quote = css[i];
			out += quote;
			mode = "string";
			i++;
			continue;
		}
		if (css[i] === "\\") {
			const esc = consumeEscape(css, i);
			if (esc.type === "newline") {
				out += "\\";
				i = esc.next;
				continue;
			}
			out += esc.char;
			i = esc.next;
			continue;
		}
		out += css[i++];
	}
	return out;
}

/** @param {string} css */
export function assertInlineCss(css) {
	if (typeof css !== "string") throw new Error("the theme is not text");
	const text = css.replace(/^\uFEFF/, "");
	if (!text.trim()) throw new Error("the theme is empty");
	if (text.length > MAX) throw new Error("the theme is too long");
	if (/[<>]/.test(text)) throw new Error("the theme has a tag");
	const parsed = cssForChecks(text);
	if (/@import\b/i.test(parsed)) throw new Error("the theme imports a stylesheet");
	if (/@font-face\b/i.test(parsed)) throw new Error("the theme loads a font");
	if (/url\s*\(/i.test(parsed)) throw new Error("the theme loads a url");
	if (/expression\s*\(/i.test(parsed) || /javascript\s*:/i.test(parsed)) throw new Error("the theme has a script");
	if (/-moz-binding\s*:/i.test(parsed) || /behavior\s*:/i.test(parsed)) throw new Error("the theme has a binding");
	return text;
}

/** Module source with the same exports as `src/theme.ts`. */
export function themeModule(css) {
	const safe = assertInlineCss(css);
	return `export const PAGE_STYLE = ${JSON.stringify(safe)};\nexport function pageStyle(): string {\n\treturn PAGE_STYLE;\n}\n`;
}

/**
 * Replacement for `src/theme.ts` when `file` is set. Null leaves the neutral module in place.
 * @param {string} id
 * @param {string | undefined} file
 */
export function applyWorkerTheme(id, file) {
	if (!file) return null;
	const clean = id.split("?")[0].replaceAll("\\", "/");
	if (!clean.endsWith("/src/theme.ts")) return null;
	let css;
	try {
		css = fs.readFileSync(path.resolve(file), "utf8");
	} catch {
		throw new Error("WORKER_THEME could not be read");
	}
	try {
		return themeModule(css);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "the theme was refused";
		throw new Error(`WORKER_THEME was refused (${reason})`);
	}
}
