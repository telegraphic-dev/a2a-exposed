// Announce this inbox's address to paired peers, and keep the previous address forwarding for a grace period.
// The pairing identity private key stays in peer-identity.json (mode 600) or sealed on the Worker. It is never printed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";
import { CLI, die, httpJson } from "./a2a.mjs";
import { baseUrl } from "./commands.mjs";

const IDENTITY_FILE = () => path.join(C.CONFIG_DIR, "peer-identity.json");

function b64url(buf) {
	return Buffer.from(buf).toString("base64url");
}

/** Local Ed25519 key, created on first use. The file is mode 600. */
export function loadOrCreateLocalIdentity() {
	const file = IDENTITY_FILE();
	try {
		const cur = JSON.parse(fs.readFileSync(file, "utf8"));
		if (cur && typeof cur.publicKey === "string" && typeof cur.privateKey === "string" && cur.publicKey && cur.privateKey)
			return { publicKey: cur.publicKey, privateKey: cur.privateKey };
	} catch { /* create below */ }
	const kp = crypto.generateKeyPairSync("ed25519");
	// JWK `x` is the raw 32-byte public key. PKCS8 is what the Worker imports. Both are base64url.
	const publicKey = kp.publicKey.export({ format: "jwk" }).x;
	const privateKey = b64url(kp.privateKey.export({ type: "pkcs8", format: "der" }));
	const ident = { publicKey, privateKey };
	if (!ident.publicKey || !ident.privateKey) die("could not create a pairing identity");
	fs.mkdirSync(C.CONFIG_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(ident, null, 2) + "\n", { mode: 0o600 });
	try { fs.chmodSync(file, 0o600); } catch { /* the write mode is already 600 */ }
	return ident;
}

async function ownerCall(method, p, body) {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) return null;
	return httpJson(base + p, { method, body, headers: { authorization: `Bearer ${tok}` } });
}

const ownerError = (r) => (r.data && typeof r.data === "object" && typeof r.data.error === "string" ? r.data.error : `HTTP ${r.status}`);

/** Public key to name in a pairing request. Prefers the key this inbox already serves on its card. */
export async function publicIdentityForConnect() {
	let local = null;
	const ensureLocal = () => local || (local = loadOrCreateLocalIdentity());
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) return ensureLocal().publicKey;
	let got;
	try { got = await ownerCall("GET", "/owner/identity"); }
	catch { return ensureLocal().publicKey; }
	if (!got) return ensureLocal().publicKey;
	if (got.status === 200 && got.data && typeof got.data.publicKey === "string" && got.data.publicKey) {
		const file = IDENTITY_FILE();
		if (fs.existsSync(file)) {
			try {
				const cur = JSON.parse(fs.readFileSync(file, "utf8"));
				if (cur.publicKey && cur.publicKey !== got.data.publicKey)
					console.error("note: the local pairing identity differs from this A2A endpoint. connect uses the endpoint's identity, which is the one its card can prove.");
			} catch { /* unreadable local file: the endpoint key still wins */ }
		}
		return got.data.publicKey;
	}
	if (got.status === 200 && got.data && got.data.publicKey == null) {
		const ident = ensureLocal();
		try {
			const put = await ownerCall("PUT", "/owner/identity", { publicKey: ident.publicKey, privateKey: ident.privateKey });
			if (put && put.status === 200 && put.data && put.data.publicKey) return put.data.publicKey;
		} catch { /* the request still carries the local public key */ }
		return ident.publicKey;
	}
	return ensureLocal().publicKey;
}

async function requireIdentityOnWorker() {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`${CLI} init\` or edit ${C.CONFIG_FILE})`);
	let got;
	try { got = await ownerCall("GET", "/owner/identity"); }
	catch (e) { die(`could not reach this A2A endpoint: ${e?.message || e}`); }
	if (!got || got.status === 404) die(`this A2A endpoint's Worker predates address announcements: run \`${CLI} deploy\` first`);
	if (got.status !== 200) die(`could not read the pairing identity: ${ownerError(got)}`);
	if (got.data && got.data.publicKey) return got.data.publicKey;
	const ident = loadOrCreateLocalIdentity();
	const put = await ownerCall("PUT", "/owner/identity", { publicKey: ident.publicKey, privateKey: ident.privateKey });
	if (!put || put.status !== 200) die(`could not install the pairing identity: ${put ? ownerError(put) : "no answer"}`);
	return put.data.publicKey;
}

export async function announce(o = {}) {
	if (!!o.to === !!o.all) die(`usage: ${CLI} peer announce (--to <alias> | --all) [--json]`);
	if (o.to !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(o.to)) die("--to must be a peer alias");
	await requireIdentityOnWorker();
	const r = await ownerCall("POST", "/owner/peers/announce", o.all ? { all: true } : { to: o.to });
	if (!r || r.status !== 200) die(`could not announce this address: ${r ? ownerError(r) : "no answer"}`);
	const results = Array.isArray(r.data.results) ? r.data.results : [];
	if (results.length === 1 && results[0].alias === "*") die(results[0].detail || "could not announce this address");
	if (o.json) return console.log(JSON.stringify({ results }));
	if (!results.length) return console.log("No synced peer to announce to. Run peers sync after connect.");
	for (const row of results) {
		const host = row.host ? ` (${row.host})` : "";
		console.log(`${row.alias}${host}: ${row.status}${row.detail ? ` — ${row.detail}` : ""}`);
	}
}

export async function forward(o = {}) {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`${CLI} init\` or edit ${C.CONFIG_FILE})`);
	if (o.off) {
		const r = await ownerCall("DELETE", "/owner/address-forward");
		if (!r || r.status === 404) die(`this A2A endpoint's Worker predates address forwarding: run \`${CLI} deploy\` first`);
		if (r.status !== 200) die(`could not clear the grace forward: ${ownerError(r)}`);
		return console.log("grace forward cleared");
	}
	if (!o.to) die(`usage: ${CLI} peer forward --to <card-url> [--hours N] | ${CLI} peer forward --off`);
	let hours;
	if (o.hours !== undefined) {
		if (!/^\d{1,4}$/.test(String(o.hours))) die("--hours must be a whole number from 1 to 720 (default 168)");
		hours = Number(o.hours);
	}
	const r = await ownerCall("PUT", "/owner/address-forward", { cardUrl: o.to, ...(hours ? { hours } : {}) });
	if (!r || r.status === 404) die(`this A2A endpoint's Worker predates address forwarding: run \`${CLI} deploy\` first`);
	if (r.status !== 200) die(`could not set the grace forward: ${ownerError(r)}`);
	const until = r.data.until || "";
	if (o.json) return console.log(JSON.stringify({ cardUrl: r.data.cardUrl, until }));
	console.log(`grace forward to ${r.data.cardUrl}${until ? ` until ${until}` : ""}`);
}
