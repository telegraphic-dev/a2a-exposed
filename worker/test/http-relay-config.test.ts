import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

test("HTTP relay deployment configuration is opt-in and independently composes hosted and wake bindings", async () => {
	const built = await build({ entryPoints: ["cloudflare.config.ts"], bundle: true, write: false, format: "cjs", platform: "neutral", plugins: [{ name: "config-contract", setup(b) {
		b.onResolve({ filter: /^cf\/config$/ }, () => ({ path: "config", namespace: "fixture" }));
		b.onResolve({ filter: /^\.\/src\/(index|relay-entry|hosted)\.ts$/ }, a => ({ path: a.path, namespace: "fixture" }));
		b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.path === "config" ? `export const defineConfig = f => f; export const bindings = new Proxy({}, { get: (_, name) => value => ({binding: name, value}) }); export const exports = {durableObject: value => ({export: 'durableObject',value})}; export const triggers = {scheduled: value => value};` : `export const selected = ${JSON.stringify(a.path)};`, loader: "js" }));
	} }] });
	const config = (env: Record<string, string>) => { const module = { exports: {} as any }; runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, process: { env } }); return module.exports.default({ mode: "production" }).worker; };
	const off = config({}); assert.equal(off.entrypoint.selected, "./src/index.ts"); assert.equal(off.exports, undefined); assert.equal(off.env.HTTP_RELAY, undefined); assert.equal(off.env.HTTP_RELAY_ENABLED, undefined);
	const on = config({ A2A_HTTP_RELAY: "1" }); assert.equal(on.entrypoint.selected, "./src/relay-entry.ts"); assert.equal(on.exports.HttpRelay.export, "durableObject"); assert.equal(on.exports.WakeRelay, undefined); assert.equal(on.env.HTTP_RELAY.value.exportName, "HttpRelay"); assert.equal(on.env.HTTP_RELAY_ENABLED.value, "1"); assert.equal(on.compatibilityFlags.join(","), "enable_request_signal"); assert.equal(off.compatibilityFlags, undefined); assert.equal(on.env.WAKE_RELAY, undefined);
	const combined = config({ A2A_HTTP_RELAY: "1", A2A_WAKE_RELAY: "1", TENANCY: "host" }); assert.equal(combined.entrypoint.selected, "./src/hosted.ts"); assert.ok(combined.exports.HttpRelay); assert.ok(combined.exports.WakeRelay); assert.ok(combined.exports.TenantStore);
	const wakeOnly = config({ A2A_WAKE_RELAY: "1" }); assert.equal(wakeOnly.env.HTTP_RELAY, undefined); assert.ok(wakeOnly.exports.WakeRelay);
	for (const value of ["0", "true", "yes"]) assert.equal(config({ A2A_HTTP_RELAY: value }).env.HTTP_RELAY, undefined);
	const core = readFileSync("../control/src/core/http-relay-metadata.ts", "utf8"); assert.match(core, /HTTP_RELAY_PROTOCOL_VERSION = 2/); assert.match(core, /response-stream-v1/);
});
