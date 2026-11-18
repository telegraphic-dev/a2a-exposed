// Per-agent social card: the shared 1200×630 card with this agent's address in the prompt box and, when new
// connection requests are off, the matching footer. No image library: the shared PNG is inflated with the
// platform DecompressionStream, glyph masks are blended in, and the result is deflated again.
//
// Only hostname characters are drawn; any other address keeps the shared card, so peer- or owner-chosen text never
// reaches the image. A long address is drawn smaller, then shortened in the middle. Rendering costs tens of
// milliseconds of CPU, so hosted.ts serves the response through cachedSocialCard (below) by its content-addressed URL.
import { LANDING_SOCIAL_IMAGE } from "./landing-social-image.ts";
import { FOOTER_OFF, GLYPH_CHARS, GLYPH_MASKS, GLYPH_PAD, GLYPH_SETS } from "./social-card-glyphs.ts";

/** Bump when the drawing changes, so cached cards and social-platform copies are replaced. */
export const SOCIAL_CARD_DESIGN = "v2";
const W = 1200, H = 630, BPP = 3, STRIDE = W * BPP;
const BOX = { x0: 96, y0: 334, x1: 1104, y1: 404, fill: [14, 21, 15] }; // prompt box interior, inside the rounded border
const LINE_X = 117, LINE_RIGHT = 1088; // the shared card's prompt origin and the last usable column
const FOOTER_CLEAR = { x0: 84, y0: 540, x1: 600, y1: 576, fill: [10, 15, 10] };
const TEXT = [230, 237, 231], ADDRESS = [34, 197, 94], FOOTER = [118, 138, 123];
const PREFIX = "Connect to ";
const HOST = /^[a-z0-9.:-]+$/;

export type CardText = { size: number; address: string };

/** The prompt line layout: the largest size that fits, else the smallest with a middle ellipsis. Null if not drawable. */
export function cardLayout(address: string): CardText | null {
	if (!address || address.length > 253 || !HOST.test(address)) return null;
	const room = (s: (typeof GLYPH_SETS)[number]) => Math.floor((LINE_RIGHT - LINE_X) / s.advance) - PREFIX.length;
	for (const s of GLYPH_SETS) if (address.length <= room(s)) return { size: s.size, address };
	const n = room(GLYPH_SETS[GLYPH_SETS.length - 1]) - 1;
	const head = Math.ceil(n / 2), tail = n - head;
	return { size: GLYPH_SETS[GLYPH_SETS.length - 1].size, address: `${address.slice(0, head)}…${address.slice(-tail)}` };
}

/** Short content hash for the image URL: the same address, pairing state and design always give the same URL. */
export async function socialCardKey(address: string, pairing: boolean): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SOCIAL_CARD_DESIGN}\n${address}\n${pairing ? 1 : 0}`));
	return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const SOCIAL_CARD_PATH = /^\/og-card-v2-([0-9a-f]{16})\.png$/;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
	return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function b64(s: string): Uint8Array {
	return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

let basePixels: Promise<Uint8Array> | undefined;
let glyphMasks: Promise<Uint8Array> | undefined;

/** Unfiltered RGB rows of the shared card (8-bit, colour type 2, not interlaced). */
async function decodeBase(): Promise<Uint8Array> {
	const png = b64(LANDING_SOCIAL_IMAGE);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const idat: Uint8Array[] = [];
	for (let i = 8; i < png.length;) {
		const len = view.getUint32(i), type = String.fromCharCode(...png.subarray(i + 4, i + 8));
		if (type === "IHDR" && (view.getUint32(i + 8) !== W || view.getUint32(i + 12) !== H || png[i + 16] !== 8 || png[i + 17] !== 2 || png[i + 20] !== 0)) throw new Error("unexpected base card format");
		if (type === "IDAT") idat.push(png.subarray(i + 8, i + 8 + len));
		i += 12 + len;
	}
	const raw = await pipe(concat(idat), new DecompressionStream("deflate"));
	const out = new Uint8Array(H * STRIDE);
	for (let y = 0; y < H; y++) {
		const f = raw[y * (STRIDE + 1)], src = y * (STRIDE + 1) + 1, row = y * STRIDE, up = row - STRIDE;
		for (let x = 0; x < STRIDE; x++) {
			const a = x >= BPP ? out[row + x - BPP] : 0, b = y ? out[up + x] : 0, c = y && x >= BPP ? out[up + x - BPP] : 0;
			let p = raw[src + x];
			if (f === 1) p += a;
			else if (f === 2) p += b;
			else if (f === 3) p += (a + b) >> 1;
			else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			out[row + x] = p;
		}
	}
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

function fill(px: Uint8Array, r: { x0: number; y0: number; x1: number; y1: number; fill: number[] }) {
	for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) px.set(r.fill, y * STRIDE + x * BPP);
}

/** Blend an alpha mask in one colour onto the pixels, clipped to the canvas. */
function blend(px: Uint8Array, mask: Uint8Array, offset: number, w: number, h: number, x0: number, y0: number, rgb: number[]) {
	for (let y = 0; y < h; y++) {
		const cy = y0 + y;
		if (cy < 0 || cy >= H) continue;
		for (let x = 0; x < w; x++) {
			const a = mask[offset + y * w + x], cx = x0 + x;
			if (!a || cx < 0 || cx >= W) continue;
			const i = cy * STRIDE + cx * BPP;
			for (let k = 0; k < 3; k++) px[i + k] = (px[i + k] * (255 - a) + rgb[k] * a + 127) / 255 | 0;
		}
	}
}

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	let c = 0xffffffff;
	for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
	view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
	return out;
}

/** PNG with the Sub filter on every row: cheap, and the flat card areas compress to runs. */
async function encode(px: Uint8Array): Promise<Uint8Array> {
	const raw = new Uint8Array(H * (STRIDE + 1));
	for (let y = 0; y < H; y++) {
		const o = y * (STRIDE + 1), row = y * STRIDE;
		raw[o] = 1;
		for (let x = 0; x < STRIDE; x++) raw[o + 1 + x] = px[row + x] - (x >= BPP ? px[row + x - BPP] : 0);
	}
	const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
	v.setUint32(0, W); v.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 2;
	return concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
		chunk("IDAT", await pipe(raw, new CompressionStream("deflate"))), chunk("IEND", new Uint8Array())]);
}

const rendered = new Map<string, Promise<Uint8Array | null>>();

/** renderSocialCard, memoized per isolate for a few cards so concurrent cache misses draw once. */
export function socialCardPng(address: string, pairing: boolean): Promise<Uint8Array | null> {
	const key = `${address}\n${pairing ? 1 : 0}`;
	let png = rendered.get(key);
	if (!png) {
		png = renderSocialCard(address, pairing);
		png.catch(() => rendered.delete(key));
		if (rendered.size >= 8) rendered.delete(rendered.keys().next().value!);
		rendered.set(key, png);
	}
	return png;
}

/** The per-agent card as PNG bytes, or null when the address cannot be drawn (the caller serves the shared card). */
export async function renderSocialCard(address: string, pairing: boolean): Promise<Uint8Array | null> {
	const layout = cardLayout(address);
	if (!layout) return null;
	basePixels ??= decodeBase();
	glyphMasks ??= pipe(b64(GLYPH_MASKS), new DecompressionStream("deflate"));
	const [base, masks] = await Promise.all([basePixels, glyphMasks]);
	const px = base.slice();
	fill(px, BOX);
	let offset = 0;
	for (const s of GLYPH_SETS) {
		const cell = s.width * s.height;
		if (s.size === layout.size) {
			const line = PREFIX + layout.address;
			for (let i = 0; i < line.length; i++) {
				const g = GLYPH_CHARS.indexOf(line[i]);
				if (g < 0) return null;
				blend(px, masks, offset + g * cell, s.width, s.height, LINE_X + i * s.advance - GLYPH_PAD, s.top, i < PREFIX.length ? TEXT : ADDRESS);
			}
		}
		offset += GLYPH_CHARS.length * cell;
	}
	if (!pairing) {
		fill(px, FOOTER_CLEAR);
		blend(px, masks, offset, FOOTER_OFF.width, FOOTER_OFF.height, FOOTER_OFF.x, FOOTER_OFF.y, FOOTER);
	}
	return encode(px);
}

/**
 * Per-agent social cards are drawn in the tenant object (hosted.ts forwards there) and are content-addressed, so
 * each data centre keeps one copy. The key drops the query string, so `?x=` cannot force another drawing. Only a
 * 200 is stored; a redirect for an old key and every error pass through uncached. hosted.ts calls this after the
 * directory status check, so suspended and deleted agents are refused before the cache.
 */
export async function cachedSocialCard(req: Request, ectx: ExecutionContext, forward: () => Promise<Response>): Promise<Response> {
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	if (!cache) return forward();
	const url = new URL(req.url);
	const key = new Request(url.origin + url.pathname);
	const hit = await cache.match(key).catch(() => undefined);
	if (hit) return hit;
	const res = await forward();
	if (res.status === 200 && res.headers.get("content-type") === "image/png") ectx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
	return res;
}
