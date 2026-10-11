// Build-time check for WORKER_THEME. The Worker inlines the result in a nonce'd style block and
// does not load a stylesheet, font, or image. Unsafe CSS is refused so the build stops.
import fs from "node:fs";
import path from "node:path";

const MAX = 16384;

/** @param {string} css */
export function assertInlineCss(css) {
	if (typeof css !== "string") throw new Error("the theme is not text");
	const text = css.replace(/^\uFEFF/, "");
	if (!text.trim()) throw new Error("the theme is empty");
	if (text.length > MAX) throw new Error("the theme is too long");
	if (/[<>]/.test(text)) throw new Error("the theme has a tag");
	if (/@import\b/i.test(text)) throw new Error("the theme imports a stylesheet");
	if (/@font-face\b/i.test(text)) throw new Error("the theme loads a font");
	if (/url\s*\(/i.test(text)) throw new Error("the theme loads a url");
	if (/expression\s*\(/i.test(text) || /javascript\s*:/i.test(text)) throw new Error("the theme has a script");
	if (/-moz-binding\s*:/i.test(text) || /behavior\s*:/i.test(text)) throw new Error("the theme has a binding");
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
