// #470: proxy environment support and real network/TLS errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loopbackNoProxy, networkCode, networkProblem, prepareProxy, proxySupport, proxyVar } from "../lib/net.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const BIN = path.join(root, "bin/a2a-exposed.mjs");
const SECRET_PROXY = "http://proxy-user:proxy-secret@proxy.example:8080";
const fetchError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });

function cleanEnv(extra = {}) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|CONTROL_|HOSTED_|WAKE_|PEER_|CF_|CLOUDFLARE_|NODE_USE_ENV_PROXY$|NO_PROXY$|no_proxy$)/i.test(k) && !/^(https?_proxy)$/i.test(k)));
	return { ...env, A2A_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", ...extra };
}

test("proxy support follows the Node version and an in-process global proxy", () => {
	assert.equal(proxySupport("22.18.0", null), "none");
	assert.equal(proxySupport("22.20.9", null), "none");
	assert.equal(proxySupport("23.11.0", null), "none");
	assert.equal(proxySupport("22.21.0", null), "env");
	assert.equal(proxySupport("24.0.0", null), "env");
	assert.equal(proxySupport("22.18.0", () => {}), "global");
	assert.equal(proxyVar({}), "");
	assert.equal(proxyVar({ http_proxy: " " }), "");
	assert.equal(proxyVar({ https_proxy: "http://p.example:3128" }), "https_proxy");
});

test("loopback hosts are always added to NO_PROXY, keeping the user's entries", () => {
	assert.equal(loopbackNoProxy(""), "localhost,127.0.0.1,::1");
	assert.equal(loopbackNoProxy("internal.example, localhost"), "internal.example,localhost,127.0.0.1,::1");
	assert.equal(loopbackNoProxy("*"), "*");
});

test("prepareProxy restarts once with NODE_USE_ENV_PROXY=1, applies a global proxy in-process, and respects an explicit choice", () => {
	const none = {};
	assert.equal(prepareProxy(none, { support: "env" }), "ready");
	assert.deepEqual(none, {}, "no proxy variable: nothing changes");

	const env = { HTTPS_PROXY: SECRET_PROXY, NO_PROXY: "corp.example" };
	assert.equal(prepareProxy(env, { support: "env" }), "reexec");
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
	assert.equal(env.NO_PROXY, "corp.example,localhost,127.0.0.1,::1");
	assert.equal(prepareProxy(env, { support: "env" }), "ready", "the restarted process does not restart again");

	const lower = { https_proxy: SECRET_PROXY, no_proxy: "corp.example" };
	assert.equal(prepareProxy(lower, { support: "env" }), "reexec");
	assert.equal(lower.no_proxy, "corp.example,localhost,127.0.0.1,::1");
	assert.equal(lower.NO_PROXY, undefined);

	let calls = 0;
	const global = { HTTPS_PROXY: SECRET_PROXY };
	assert.equal(prepareProxy(global, { support: "global", setGlobal: () => { calls++; } }), "ready");
	assert.equal(calls, 1);
	assert.equal(global.NODE_USE_ENV_PROXY, undefined);

	for (const choice of ["0", ""]) {
		const off = { HTTPS_PROXY: SECRET_PROXY, NODE_USE_ENV_PROXY: choice };
		assert.equal(prepareProxy(off, { support: "env" }), "ready");
		assert.equal(off.NO_PROXY, undefined, "an explicit NODE_USE_ENV_PROXY leaves the environment alone");
	}
	const old = { HTTPS_PROXY: SECRET_PROXY };
	assert.equal(prepareProxy(old, { support: "none" }), "ready");
	assert.deepEqual(old, { HTTPS_PROXY: SECRET_PROXY });
});

test("network problems name the host and the real cause, never the proxy URL", () => {
	assert.equal(networkCode(fetchError("ENOTFOUND")), "ENOTFOUND");
	assert.equal(networkCode(Object.assign(new Error("t"), { name: "TimeoutError" })), "TIMEOUT");
	assert.equal(networkCode(new TypeError("fetch failed", { cause: { code: "not a code; rm -rf" } })), "");
	const origin = "https://a2a.example";
	const cases = [
		["ENOTFOUND", /^Could not resolve a2a\.example \(ENOTFOUND\)\./],
		["ECONNREFUSED", /^The connection to a2a\.example was refused \(ECONNREFUSED\)\./],
		["ECONNRESET", /closed before an answer \(ECONNRESET\)/],
		["UND_ERR_CONNECT_TIMEOUT", /did not answer in time \(UND_ERR_CONNECT_TIMEOUT\)/],
		["SELF_SIGNED_CERT_IN_CHAIN", /TLS certificate check for a2a\.example failed \(SELF_SIGNED_CERT_IN_CHAIN\)\. Check the system clock/],
		["SOMETHING_ELSE", /^Could not reach a2a\.example \(SOMETHING_ELSE\)\.$/],
	];
	for (const [code, pattern] of cases) {
		const problem = networkProblem(fetchError(code), origin, {});
		assert.equal(problem.code, code);
		assert.match(problem.message, pattern);
	}
	assert.equal(networkProblem(new TypeError("fetch failed"), origin, {}).code, "network");

	const proxied = { HTTPS_PROXY: SECRET_PROXY, NODE_USE_ENV_PROXY: "1" };
	const tls = networkProblem(fetchError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), origin, proxied).message;
	assert.match(tls, /If the proxy in HTTPS_PROXY inspects TLS, set NODE_EXTRA_CA_CERTS/);
	assert.match(networkProblem(fetchError("ECONNREFUSED"), origin, proxied).message, /go through the proxy in HTTPS_PROXY; check that proxy, or list the host in NO_PROXY/);
	const ignored = networkProblem(fetchError("ENOTFOUND"), origin, { https_proxy: SECRET_PROXY, NODE_USE_ENV_PROXY: "0" }).message;
	assert.match(ignored, /https_proxy is set, but this Node v[\d.]+ does not use it for fetch\. Use Node 22\.21\+ or 24\+/);
	for (const message of [tls, ignored]) assert.ok(!message.includes("proxy-secret") && !message.includes("proxy.example"));
});

test("hosted setup reports the real network error instead of 'did not answer with JSON'", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-net-"));
	try {
		const routes = path.join(dir, "routes.json");
		const run = (routeMap, extra = {}) => {
			fs.writeFileSync(routes, JSON.stringify(routeMap));
			return spawnSync(process.execPath, ["--import", path.join(root, "test/fetch-stub.mjs"), BIN, "hosted", "capabilities", "--control-url", "https://control.example", "--json"],
				{ encoding: "utf8", env: cleanEnv({ A2A_CONFIG_DIR: dir, A2A_TEST_FETCH_ROUTES: routes, ...extra }) });
		};
		const down = run({});
		assert.equal(down.status, 1, down.stderr);
		const result = JSON.parse(down.stdout);
		assert.equal(result.code, "unavailable");
		assert.equal(result.network, "ENOTFOUND");
		assert.match(result.next, /^Could not resolve control\.example \(ENOTFOUND\)\. No answer was received/);
		assert.doesNotMatch(result.next, /did not answer with JSON/);

		const html = run({ "https://control.example/api/v1/setup/capabilities": { status: 502, body: "<html>bad gateway</html>" } });
		assert.equal(html.status, 1);
		assert.match(JSON.parse(html.stdout).next, /answered HTTP 502 without JSON/);

		const proxied = run({}, { HTTPS_PROXY: SECRET_PROXY, NODE_USE_ENV_PROXY: "0" });
		assert.equal(proxied.status, 1);
		assert.match(JSON.parse(proxied.stdout).next, /HTTPS_PROXY is set, but this Node/);
		assert.ok(!(proxied.stdout + proxied.stderr).includes("proxy-secret"));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with HTTPS_PROXY set, CLI fetches go through the proxy and loopback bypasses it", { skip: proxySupport() === "none" && "this Node cannot use proxy variables for fetch" }, async (t) => {
	const seen = [];
	const proxy = net.createServer((socket) => {
		socket.once("data", (chunk) => {
			seen.push(String(chunk).split("\r\n")[0]);
			socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
		});
	});
	await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	t.after(() => proxy.close());
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-proxy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const proxyUrl = `http://proxy-user:proxy-secret@127.0.0.1:${proxy.address().port}`;
	const run = (args) => new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv({ A2A_CONFIG_DIR: dir, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl }), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	const r = await run(["hosted", "capabilities", "--control-url", "https://control.example", "--json"]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.deepEqual(seen, ["CONNECT control.example:443 HTTP/1.1"], "the request went to the proxy");
	const result = JSON.parse(r.stdout);
	assert.equal(result.code, "unavailable");
	assert.match(result.next, /go through the proxy in HTTPS_PROXY/);
	assert.doesNotMatch(r.stderr, /EnvHttpProxyAgent is experimental/);
	assert.ok(!(r.stdout + r.stderr).includes("proxy-secret"));

	// A local endpoint is reached directly: the proxy sees nothing more.
	const local = net.createServer((socket) => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")));
	await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
	t.after(() => local.close());
	fs.writeFileSync(path.join(dir, "config.env"), `A2A_BASE_URL=http://127.0.0.1:${local.address().port}\nA2A_OWNER_TOKEN=owner-tok\n`, { mode: 0o600 });
	await run(["inbox", "--json"]);
	assert.equal(seen.length, 1, `loopback went through the proxy: ${seen.join(" | ")}`);
});
