import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { startFixture, exerciseSDK } from "./http-relay-sdk-fixture.mjs";
const execute = promisify(execFile);

for (const legacy of [false, true]) test(`official A2A SDK 1.3 / protocol ${legacy ? "0.3" : "1.0"} through actual Worker and native CLI`, { timeout: 45000 }, async t => {
	const root = resolve(process.env.HTTP_RELAY_WORKER_ROOT || ".");
	const built = await build({ absWorkingDir: root, entryPoints: ["src/relay-entry.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const publicOrigin = "https://agent.example.com";
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-relay-sdk", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], d1Databases: ["DB"], durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } }, bindings: { OWNER_TOKEN: "fixture-owner", PUBLIC_URL: publicOrigin, HTTP_RELAY_ENABLED: "1", MCP: "off" } }));
	const dir = mkdtempSync(join(tmpdir(), "http-relay-official-sdk-"));
	const fixture = await startFixture();
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const db = await mf.getD1Database("DB");
		for (const file of readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort()) await db.exec(readFileSync(join(root, "migrations", file), "utf8").replace(/--[^\n]*/g, "").replace(/\n/g, " "));
		const local = await mf.ready;
		const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|HTTP_RELAY_|NODE_OPTIONS$)/.test(key))), A2A_CONFIG_DIR: dir, A2A_BASE_URL: local.origin, A2A_OWNER_TOKEN: "fixture-owner", DO_NOT_TRACK: "1" };
		const cli = resolve(process.env.HTTP_RELAY_CLI || "../cli/bin/a2a-exposed.mjs");
		const tokenFile = join(dir, "connector"), ingressFile = join(dir, "ingress");
		await execute(process.execPath, [cli, "relay", "a2a", "create", "--token-file", tokenFile, "--ingress-token-file", ingressFile, "--forward-headers", "content-type,accept,authorization,a2a-version,last-event-id"], { env, cwd: dir, timeout: 10000 });
		child = spawn(process.execPath, [cli, "relay", "a2a", "run", "--url", new URL("/relay/http/a2a/connect", local).href.replace("http:", "ws:"), "--token-file", tokenFile, "--local-url", fixture.base + "/rpc"], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		let diagnostics = ""; child.stderr!.on("data", chunk => { diagnostics += chunk; });
		const deadline = Date.now() + 8000;
		for (;;) {
			assert.equal(child.exitCode, null, `connector exited: ${diagnostics}`);
			const status = await fetch(new URL("/owner/relay/http/a2a", local), { headers: { authorization: "Bearer fixture-owner" } });
			if ((await status.json() as any).connected) break;
			assert.ok(Date.now() < deadline, "connector must become ready"); await new Promise(r => setTimeout(r, 20));
		}
		const ingress = readFileSync(ingressFile, "utf8").trim();
		const publicFetch: typeof fetch = async (input, init) => {
			const req = new Request(input, init); const url = new URL(req.url);
			assert.equal(url.origin, publicOrigin, "SDK must use the rewritten public endpoint, not the receiver");
			const headers = new Headers(req.headers); headers.set("x-a2a-relay-authorization", `Bearer ${ingress}`);
			return fetch(new Request(new URL(url.pathname + url.search, local), { method: req.method, headers, body: req.body, signal: req.signal, duplex: "half" } as RequestInit));
		};
		const receipts = await exerciseSDK({ base: publicOrigin + "/relay/a2a", fetchImpl: publicFetch, fixture, versions: [legacy], onStep: (step: string) => t.diagnostic(step) });
		assert.equal(receipts.length, 1);
		t.diagnostic(JSON.stringify({ sdk: "@a2a-js/sdk@1.3.0", receipts }));
	} finally {
		if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
		await fixture.close(); await mf.dispose(); rmSync(dir, { recursive: true, force: true });
	}
});
