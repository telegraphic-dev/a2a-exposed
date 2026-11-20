// GET /owner/peers marks an active encrypted key pairing with `sealed: true` and its safety code, computed from the
// stored public bundles only. Plaintext, token and revoked rows stay unchanged, and no key material is listed.
// Run: npm test (also with STORAGE_BACKEND=d1 and STORAGE_BACKEND=do)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import worker, { runOwnerRpc } from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { requestSafetyCode, requestSafetyEmoji } from "../src/sealed-keys.ts";
import { hostedTenantContext } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const ectx = { waitUntil() {}, passThroughOnException() {} };
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const b64 = (n: number) => randomBytes(n).toString("base64url");
// Public bundle fields only. The safety code reads cardUrl, identityKey and keyId; the rest is filler of the stored shape.
const bundle = (cardUrl: string) => ({ v: 1, suite: "HPKE-X25519-SHA256-ChaCha20Poly1305", cardUrl, identityKey: b64(32), encryptionKey: b64(32), keyId: b64(32), notBefore: stamp(0), signature: b64(64) });
// Independent copy of the CLI's localSafetyCode (encryption/local-state.mjs), so the Worker code is checked against it.
const cliSafetyCode = (a: any, b: any) => {
	const tuples = [a, b].map((x) => ({ cardUrl: x.cardUrl, identityKey: x.identityKey, keyId: x.keyId }))
		.sort((p, q) => Buffer.compare(Buffer.from(p.identityKey, "base64url"), Buffer.from(q.identityKey, "base64url")) || p.cardUrl.localeCompare(q.cardUrl));
	const hex = createHash("sha256").update("a2a-exposed sealed safety v1\n" + JSON.stringify(tuples)).digest("hex");
	return (BigInt("0x" + hex) % 10n ** 60n).toString().padStart(60, "0").match(/.{5}/g)!.join(" ");
};

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Peers" };
	const requester = bundle("https://ada.example.net/.well-known/agent-card.json");
	const responder = bundle(BASE + "/.well-known/agent-card.json");
	const revokedRequester = bundle("https://cy.example.net/.well-known/agent-card.json");
	const ins = DB.db.prepare(`INSERT INTO peers (label, token_hash, created_at, revoked_at, source, user_code, client_name, sealed_requester, sealed_responder)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	ins.run("ada", "hash-ada", stamp(1), null, "pairing", "ABCDEFGH", "Ada", JSON.stringify(requester), JSON.stringify(responder));
	ins.run("bob", "hash-bob", stamp(2), null, "pairing", "BCDFGHJK", "Bob", null, null);
	ins.run("cy", "hash-cy", stamp(3), stamp(4), "pairing", "CDFGHJKL", "Cy", JSON.stringify(revokedRequester), JSON.stringify(responder));
	ins.run("dee", "hash-dee", stamp(5), null, null, null, null, null, null);
	ins.run("eve", "hash-eve", stamp(6), null, "pairing", "DFGHJKLM", "Eve", "{not json", JSON.stringify(responder));
	const get = async (sealedFlag: string) => {
		const res = await worker.fetch(new Request(BASE + "/owner/peers", { headers: { authorization: "Bearer owner-secret" } }) as any, { ...env, A2A_SEALED_ENABLED: sealedFlag }, ectx as any);
		assert.equal(res.status, 200);
		return { text: await res.clone().text(), rows: (await res.json()) as any[] };
	};
	return { DB, env, requester, responder, revokedRequester, get };
}

test("GET /owner/peers lists sealed and the safety code only for active encrypted pairings", async () => {
	const s = setup();
	const { rows, text } = await s.get("");
	const by = Object.fromEntries(rows.map((r) => [r.label, r]));
	assert.deepEqual(rows.map((r) => r.label), ["ada", "bob", "cy", "dee", "eve"]);

	const code = cliSafetyCode(s.requester, s.responder);
	assert.match(code, /^(\d{5} ){11}\d{5}$/);
	assert.equal(by.ada.sealed, true);
	assert.equal(by.ada.safety_code, code, "matches the code the CLI prints");
 assert.deepEqual(by.ada.safety_emoji, await requestSafetyEmoji({sealed_requester:JSON.stringify(s.requester),sealed_responder:JSON.stringify(s.responder)}));
	assert.equal(by.ada.safety_code, await requestSafetyCode({ sealed_requester: JSON.stringify(s.requester), sealed_responder: JSON.stringify(s.responder) }), "matches the pairing-request code");
	assert.equal(by.ada.safety_code, cliSafetyCode(s.responder, s.requester), "argument order does not matter");

	for (const label of ["bob", "cy", "dee"]) {
		assert.equal("sealed" in by[label], false, `${label} has no sealed field`);
		assert.equal("safety_emoji" in by[label], false);
		assert.equal("safety_code" in by[label], false, `${label} has no safety_code field`);
	}
	assert.deepEqual(Object.keys(by.bob).sort(), ["card_url", "client_name", "continuation", "created_at", "label", "revoked_at", "source", "user_code"], "a plaintext row keeps its existing shape");
	assert.equal(by.eve.sealed, true, "a stored key pairing whose bundle does not parse is still marked encrypted");
	assert.equal(by.eve.safety_emoji, null);
	assert.equal(by.eve.safety_code, null, "but gets no made-up code");

	for (const k of [s.requester, s.responder, s.revokedRequester]) {
		for (const v of [k.identityKey, k.encryptionKey, k.keyId, k.signature]) assert.equal(text.includes(v), false, "no key material is listed");
	}
	assert.equal(text.includes("sealed_requester") || text.includes("sealed_responder"), false);
});

test("the sealed listing does not depend on A2A_SEALED_ENABLED", async () => {
	const s = setup();
	const off = (await s.get("")).rows;
	const on = (await s.get("1")).rows;
	assert.deepEqual(off, on);
	assert.equal(off.find((r) => r.label === "ada").sealed, true);
});

test("the hosted owner RPC returns the same sealed listing, and sealed-pairings stays off its allowlist", async () => {
	const s = setup();
	const ctx = await hostedTenantContext({ ...s.env, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key" } as any, {
		id: "ten_peers", db: s.DB, publicUrl: BASE, ownerTokenHash: await sha256("tenant-owner"), status: "active", config: { AGENT_NAME: "Peers" },
	} as any);
	const rpc = (path: string) => runOwnerRpc(ctx, ectx as any, { accountId: "acct_test", method: "GET", path });
	const peers = await rpc("/owner/peers");
	assert.equal(peers.status, 200);
	const ada = (peers.body as any[]).find((r) => r.label === "ada");
	assert.equal(ada.sealed, true);
	assert.equal(ada.safety_code, cliSafetyCode(s.requester, s.responder));
	assert.equal("sealed" in (peers.body as any[]).find((r) => r.label === "bob"), false);
	assert.notEqual((await rpc("/owner/sealed-pairings")).status, 200, "the bundle listing is still not reachable through the hosted owner RPC");
});
