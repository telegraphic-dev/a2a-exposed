import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("workerd sends the accounts GET when the bearer token contains a newline", async () => {
	const built = await build({
		entryPoints: [path.join(root, "test/cf-call-worker.ts")],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		target: "es2022",
		logLevel: "silent",
	});
	const script = built.outputFiles[0]?.text;
	assert.ok(script);
	let authorization = "";
	let method = "";
	let body = "unset";
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "cf-call",
		modules: true,
		script,
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		outboundService: async (request: Request) => {
			method = request.method;
			authorization = request.headers.get("authorization") ?? "";
			body = await request.text();
			return Response.json({ success: true, result: [] });
		},
	} as never));
	try {
		const response = await mf.dispatchFetch("https://control.example.com/?token=cf_access%0aSECRET");
		const payload = await response.json() as { ok: boolean; status: number; thrown?: { name: string; message: string } | null };
		assert.equal(payload.ok, true, JSON.stringify(payload));
		assert.equal(payload.status, 200);
		assert.equal(method, "GET");
		assert.equal(authorization, "Bearer cf_accessSECRET");
		assert.equal(body, "");
	} finally {
		await mf.dispose();
	}
});
