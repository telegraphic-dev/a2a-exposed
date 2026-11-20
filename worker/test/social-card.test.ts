import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { LANDING_SOCIAL_IMAGE } from "../src/landing-social-image.ts";
import { cachedSocialCard, cardLayout, renderSocialCard, socialCardKey, SOCIAL_CARD_PATH } from "../src/social-card.ts";

import worker, { dispatch } from "../src/index.ts";
import { hostedTenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const W = 1200, H = 630, STRIDE = W * 3;

/** RGB pixels of an 8-bit, non-interlaced PNG (independent of the Worker's decoder). */
function pixels(png: Uint8Array): Uint8Array {
	const b = Buffer.from(png), idat: Buffer[] = [];
	assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	for (let i = 8; i < b.length;) {
		const len = b.readUInt32BE(i), type = b.toString("latin1", i + 4, i + 8);
		if (type === "IHDR") assert.deepEqual([b.readUInt32BE(i + 8), b.readUInt32BE(i + 12), b[i + 16], b[i + 17], b[i + 20]], [W, H, 8, 2, 0]);
		if (type === "IDAT") idat.push(b.subarray(i + 8, i + 8 + len));
		i += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat)), out = new Uint8Array(H * STRIDE);
	for (let y = 0; y < H; y++) for (let x = 0; x < STRIDE; x++) {
		const f = raw[y * (STRIDE + 1)], v = raw[y * (STRIDE + 1) + 1 + x], o = y * STRIDE + x;
		const a = x >= 3 ? out[o - 3] : 0, up = y ? out[o - STRIDE] : 0, c = y && x >= 3 ? out[o - STRIDE - 3] : 0;
		const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
		out[o] = (v + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f]) & 255;
	}
	return out;
}

const shared = pixels(Buffer.from(LANDING_SOCIAL_IMAGE, "base64"));
const inside = (x: number, y: number, r: number[]) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
const PROMPT_BOX = [88, 326, 1112, 413], FOOTER = [80, 535, 610, 580];
/** Pixels that differ from the shared card outside the allowed rectangles. */
function changedOutside(px: Uint8Array, allowed: number[][]): number {
	let n = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const o = y * STRIDE + x * 3;
		if ((px[o] !== shared[o] || px[o + 1] !== shared[o + 1] || px[o + 2] !== shared[o + 2]) && !allowed.some(r => inside(x, y, r))) n++;
	}
	return n;
}
const greenIn = (px: Uint8Array, r: number[]) => {
	let n = 0;
	for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) { const o = y * STRIDE + x * 3; if (px[o + 1] > 150 && px[o] < 80) n++; }
	return n;
};

test("card layout draws hostnames only, shrinking and then shortening long addresses", () => {
	assert.deepEqual(cardLayout("claudia-de-bot.a2a.exposed"), { size: 30, address: "claudia-de-bot.a2a.exposed" });
	assert.equal(cardLayout("abcdefghijklmnopqrstuvwxyz012345.a2a.exposed")?.size, 25, "the longest hosted name still fits whole");
	assert.equal(cardLayout("localhost:8787")?.size, 30);
	const long = "a".repeat(120) + ".example.com", cut = cardLayout(long)!;
	assert.equal(cut.size, 20);
	assert.match(cut.address, /^a+…a*\.example\.com$/);
	assert.ok(("Connect to ".length + cut.address.length) * 12 <= 1088 - 117, "the shortened line fits the box");
	for (const bad of ["", "Agent.example", "a_b.example", "a b", "agent.example/", "<b>.example", "agënt.example", "x".repeat(254)]) assert.equal(cardLayout(bad), null, bad);
});

test("card URL key covers address, pairing state and design", async () => {
	const k = await socialCardKey("a.example", true);
	assert.match(k, /^[0-9a-f]{16}$/);
	assert.equal(k, await socialCardKey("a.example", true));
	assert.notEqual(k, await socialCardKey("a.example", false));
	assert.notEqual(k, await socialCardKey("b.example", true));
	assert.ok(SOCIAL_CARD_PATH.test(`/og-card-v2-${k}.png`));
	for (const p of ["/og-card-v2-.png", `/og-card-v2-${k}.png/x`, `/og-card-v2-${k.toUpperCase()}.png`, "/og-card-v1.png"]) assert.equal(SOCIAL_CARD_PATH.test(p), false, p);
});

test("rendered card is a bounded 1200×630 PNG that only changes the prompt box and, when pairing is off, the footer", async () => {
	const on = await renderSocialCard("claudia-de-bot.a2a.exposed", true);
	const off = await renderSocialCard("claudia-de-bot.a2a.exposed", false);
	assert.ok(on && off);
	assert.ok(on.length <= 200_000 && off.length <= 200_000, `${on.length} / ${off.length} bytes`);
	const pxOn = pixels(on), pxOff = pixels(off);
	assert.equal(changedOutside(pxOn, [PROMPT_BOX]), 0);
	assert.equal(changedOutside(pxOff, [PROMPT_BOX, FOOTER]), 0);
	assert.ok(greenIn(pxOn, [300, 334, 1104, 404]) > 500, "the address is drawn in the brand green");
	assert.equal(greenIn(shared, [300, 334, 1104, 404]), 0, "the shared card has no green address");
	let footer = 0;
	for (let y = FOOTER[1]; y < FOOTER[3]; y++) for (let x = FOOTER[0]; x < FOOTER[2]; x++) { const o = y * STRIDE + x * 3; if (pxOn[o] !== pxOff[o]) footer++; }
	assert.ok(footer > 500, "the footer text differs when pairing is off");
	assert.deepEqual(await renderSocialCard("claudia-de-bot.a2a.exposed", true), on, "rendering is deterministic");
	assert.equal(await renderSocialCard("Evil <b>name</b>", true), null);
});

const BASE = "https://alice.agents.example";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const html = (call: (r: Request) => Promise<Response>) => call(new Request(BASE + "/", { headers: { accept: "text/html" } })).then(r => r.text());
const ogImage = (page: string) => page.match(/property="og:image" content="([^"]+)"/)?.[1];

test("self-hosted agents keep the shared card and do not serve per-agent cards", async () => {
	const env: WorkerBindings = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, AGENT_NAME: "Alice" };
	const call = (r: Request) => worker.fetch(r, env, execution);
	assert.equal(ogImage(await html(call)), BASE + "/og-card-v1.png");
	const key = await socialCardKey("alice.agents.example", true);
	assert.equal((await call(new Request(`${BASE}/og-card-v2-${key}.png`))).status, 404);
});

test("hosted agents link and serve their own card; an old key redirects to the current one", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: WorkerBindings = { DB };
	const ctx = (config: Record<string, string>) => hostedTenantContext(env, { id: "tenant-alice", publicUrl: BASE, db: DB, config: { AGENT_NAME: "Alice", ...config } });
	const on = (r: Request) => dispatch(r, ctx({}), execution);
	const page = await html(on);
	const url = ogImage(page)!;
	assert.equal(url, `${BASE}/og-card-v2-${await socialCardKey("alice.agents.example", true)}.png`);
	assert.match(page, /name="twitter:image" content="https:\/\/alice\.agents\.example\/og-card-v2-[0-9a-f]{16}\.png"/);
	assert.match(page, /property="og:image:alt" content="Connect your agent to this one. Tell your agent: Connect to alice.agents.example. The owner approves every connection."/);

	const res = await on(new Request(url));
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/png");
	assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
	assert.equal(res.headers.get("x-content-type-options"), "nosniff");
	const bytes = new Uint8Array(await res.arrayBuffer());
	assert.equal(res.headers.get("content-length"), String(bytes.length));
	assert.deepEqual(bytes, await renderSocialCard("alice.agents.example", true));
	const head = await on(new Request(url, { method: "HEAD" }));
	assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(head.headers.get("content-length"), String(bytes.length));
	assert.equal((await on(new Request(url, { method: "POST" }))).status, 404);

	// Turning pairing off changes the URL and the alt text; the old URL now redirects there.
	const offCall = (r: Request) => dispatch(r, ctx({ PAIRING_APPROVAL: "off" }), execution);
	const offPage = await html(offCall), offUrl = ogImage(offPage)!;
	assert.notEqual(offUrl, url);
	assert.match(offPage, /property="og:image:alt" content="[^"]*New connection requests are turned off."/);
	const moved = await offCall(new Request(url));
	assert.equal(moved.status, 302);
	assert.equal(moved.headers.get("location"), offUrl);
	assert.equal(moved.headers.get("cache-control"), "no-store");
	assert.equal((await offCall(new Request(offUrl))).status, 200);
});

test("hosted agents whose address cannot be drawn keep the shared card", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const ctx = hostedTenantContext({ DB }, { id: "tenant-odd", publicUrl: "https://Odd_Name.example", db: DB, config: { AGENT_NAME: "Odd" } });
	const call = (r: Request) => dispatch(r, ctx, execution);
	assert.equal(ogImage(await call(new Request("https://Odd_Name.example/", { headers: { accept: "text/html" } })).then(r => r.text())), "https://Odd_Name.example/og-card-v1.png");
	assert.equal((await call(new Request("https://Odd_Name.example/og-card-v2-0123456789abcdef.png"))).status, 404);
});

test("hosted edge cache stores one 200 per card path, ignores the query string, and passes redirects through", async () => {
	const store = new Map<string, Response>();
	const cache = {
		async match(r: Request) { return store.get(r.url)?.clone(); },
		async put(r: Request, res: Response) { store.set(r.url, res); },
	};
	const previous = (globalThis as { caches?: unknown }).caches;
	(globalThis as { caches?: unknown }).caches = { default: cache };
	try {
		const pending: Promise<unknown>[] = [];
		const ectx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
		let drawn = 0;
		const png = () => { drawn++; return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })); };
		const url = `${BASE}/og-card-v2-0123456789abcdef.png`;
		assert.deepEqual(new Uint8Array(await (await cachedSocialCard(new Request(url), ectx, png)).arrayBuffer()), new Uint8Array([1, 2, 3]));
		await Promise.all(pending);
		assert.deepEqual([...store.keys()], [url]);
		await cachedSocialCard(new Request(url + "?bust=1"), ectx, png);
		await cachedSocialCard(new Request(url + "?bust=2"), ectx, png);
		assert.equal(drawn, 1, "query strings hit the same cache entry");

		const other = `${BASE}/og-card-v2-fedcba9876543210.png`;
		const redirect = () => { drawn++; return Promise.resolve(new Response(null, { status: 302, headers: { location: url } })); };
		assert.equal((await cachedSocialCard(new Request(other), ectx, redirect)).status, 302);
		assert.equal((await cachedSocialCard(new Request(other), ectx, redirect)).status, 302);
		await Promise.all(pending);
		assert.equal(drawn, 3);
		assert.equal(store.has(other), false, "redirects are not cached");
	} finally {
		(globalThis as { caches?: unknown }).caches = previous;
	}
});
