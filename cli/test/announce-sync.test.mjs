// #473: peer announce --to ALIAS syncs a connected peer first instead of failing until peers sync ALIAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");
const PEER_TOKEN = "a2apt_" + "p".repeat(40);

/** A stub owner API. `worker.outbound` is the Worker's synced list; `announce` decides each announcement result. */
async function world(t, { outbound = [], announce } = {}) {
	const calls = [];
	const state = { outbound: [...outbound], announceCount: 0 };
	const srv = http.createServer(async (req, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		const body = raw ? JSON.parse(raw) : undefined;
		calls.push({ method: req.method, url: req.url, body });
		const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
		if (req.headers.authorization !== "Bearer owner-tok") return send(401, { error: "unauthorized" });
		if (req.url === "/owner/identity") return send(200, { publicKey: "pub-key" });
		if (req.method === "GET" && req.url === "/owner/outbound-peers") return send(200, state.outbound);
		if (req.method === "PUT" && req.url.startsWith("/owner/outbound-peers/")) {
			const alias = decodeURIComponent(req.url.split("/").pop());
			state.outbound = state.outbound.filter((r) => r.alias !== alias).concat({ alias, url: body.url, has_token: !!body.token, readable: true });
			return send(200, { ok: true, alias, hasToken: !!body.token });
		}
		if (req.method === "POST" && req.url === "/owner/peers/announce") {
			state.announceCount++;
			return send(200, { results: announce ? announce(body, state) : defaultAnnounce(body, state) });
		}
		send(404, { error: "not found" });
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-announce-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "config.env"), `A2A_BASE_URL=http://127.0.0.1:${srv.address().port}\nA2A_OWNER_TOKEN=owner-tok\nPEER_ADA_TOKEN=${PEER_TOKEN}\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "peers.json"), JSON.stringify({ ada: { url: "https://ada.example.com/", token_env: "PEER_ADA_TOKEN", token_stored: true }, bob: { url: "https://bob.example.com", token_env: "PEER_BOB_TOKEN", token_stored: true } }), { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_)/.test(k) && !/^(https?_proxy|no_proxy|NODE_USE_ENV_PROXY)$/i.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1" });
	const cli = (args) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	return { calls, state, cli, dir };
}

function defaultAnnounce(body, state) {
	const aliases = body.all ? state.outbound.map((r) => r.alias) : [body.to];
	return aliases.map((alias) => {
		const row = state.outbound.find((r) => r.alias === alias);
		if (!row) return { alias, status: "failed", detail: `no peer "${alias}" synced to this A2A endpoint` };
		if (!row.has_token) return { alias, status: "failed", detail: "This peer has no stored token. Run peers sync after connect." };
		if (!row.readable) return { alias, status: "failed", detail: `the stored token for "${alias}" can't be read (the owner token was rotated since it was synced): run a2a peers sync ${alias} again` };
		return { alias, status: "updated", detail: "", host: new URL(row.url).host };
	});
}

const writes = (calls) => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);

test("#473: announce --to syncs a connected but unsynced peer first, then announces once", async (t) => {
	const w = await world(t);
	const r = await w.cli(["peer", "announce", "--to", "ada", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(writes(w.calls), ["PUT /owner/outbound-peers/ada", "POST /owner/peers/announce"]);
	const put = w.calls.find((c) => c.method === "PUT");
	assert.deepEqual(put.body, { url: "https://ada.example.com", token: PEER_TOKEN });
	assert.deepEqual(JSON.parse(r.stdout).results, [{ alias: "ada", status: "updated", detail: "", host: "ada.example.com" }]);
	assert.match(r.stderr, /synced ada to this A2A endpoint first \(as peers sync ada does\)/);
	assert.ok(!(r.stdout + r.stderr).includes(PEER_TOKEN), "the peer token is never printed");
});

test("#473: an already synced peer is not uploaded again", async (t) => {
	const w = await world(t, { outbound: [{ alias: "ada", url: "https://ada.example.com", has_token: true, readable: true }] });
	const r = await w.cli(["peer", "announce", "--to", "ada"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(writes(w.calls), ["POST /owner/peers/announce"]);
	assert.match(r.stdout, /ada \(ada\.example\.com\): updated/);
	assert.doesNotMatch(r.stderr, /synced ada/);
});

test("#473: a tokenless Worker entry is replaced with the local token, and an unreadable one is re-synced once", async (t) => {
	const tokenless = await world(t, { outbound: [{ alias: "ada", url: "https://ada.example.com", has_token: false, readable: true }] });
	const a = await tokenless.cli(["peer", "announce", "--to", "ada", "--json"]);
	assert.equal(a.status, 0, a.stderr);
	assert.deepEqual(writes(tokenless.calls), ["PUT /owner/outbound-peers/ada", "POST /owner/peers/announce"]);

	const unreadable = await world(t, { outbound: [{ alias: "ada", url: "https://ada.example.com", has_token: true, readable: false }] });
	const b = await unreadable.cli(["peer", "announce", "--to", "ada", "--json"]);
	assert.equal(b.status, 0, b.stderr);
	assert.deepEqual(writes(unreadable.calls), ["POST /owner/peers/announce", "PUT /owner/outbound-peers/ada", "POST /owner/peers/announce"]);
	assert.equal(JSON.parse(b.stdout).results[0].status, "updated");
});

test("#473: an unknown alias or a peer without a local token is left to the Worker's answer", async (t) => {
	const w = await world(t);
	const unknown = await w.cli(["peer", "announce", "--to", "carol", "--json"]);
	assert.equal(unknown.status, 0, unknown.stderr);
	assert.match(JSON.parse(unknown.stdout).results[0].detail, /no peer "carol" synced/);
	const noToken = await w.cli(["peer", "announce", "--to", "bob", "--json"]);
	assert.equal(noToken.status, 0, noToken.stderr);
	assert.equal(JSON.parse(noToken.stdout).results[0].status, "failed");
	assert.deepEqual(writes(w.calls), ["POST /owner/peers/announce", "POST /owner/peers/announce"], "nothing was uploaded");
});

test("#473: announce --all names local peers that were not announced because they are not synced", async (t) => {
	const w = await world(t, { outbound: [{ alias: "ada", url: "https://ada.example.com", has_token: true, readable: true }] });
	const r = await w.cli(["peer", "announce", "--all", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(writes(w.calls), ["POST /owner/peers/announce"], "--all never uploads peers");
	assert.match(r.stderr, /not announced \(not synced to this A2A endpoint\): bob\. Run .*peer announce --to ALIAS for each/);
});

test("#473: pinned local encryption is never synced by announce", async (t) => {
	const w = await world(t);
	const peers = JSON.parse(fs.readFileSync(path.join(w.dir, "peers.json"), "utf8"));
	peers.ada.sealed = { keyId: "local-key" };
	fs.writeFileSync(path.join(w.dir, "peers.json"), JSON.stringify(peers), { mode: 0o600 });
	const r = await w.cli(["peer", "announce", "--to", "ada", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(writes(w.calls), ["POST /owner/peers/announce"], "a pinned encrypted peer is not uploaded");
});
