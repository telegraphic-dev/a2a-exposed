// Tenant context: gates default off, self-host owner auth and peer-token key stay compatible, hosted uses a hash
// and TENANT_SECRETS_KEY. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { openPeerToken, openPeerTokenWithKey, sealPeerToken, sealPeerTokenWithKey } from "../src/mcp.ts";
import { hostedTenantContext, namespaceForRegion, parseGates, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const dummy = { prepare() { throw new Error("storage should not be touched"); } } as any;
const BASE = "https://agent.example.com";

function selfEnv(over: Record<string, unknown> = {}): WorkerBindings {
	return { DB: dummy, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", ...over } as WorkerBindings;
}

test("gates: unset is single-tenant and every reserved gate is off", () => {
	const g = parseGates({ DB: dummy } as WorkerBindings).gates;
	assert.equal(g.tenancy, "single");
	assert.equal(g.hostedStorage, false);
	assert.equal(g.quotas, false);
	assert.equal(g.usageSink, "");
	assert.equal(g.wakeTargetPolicy, "");
	assert.equal(g.signupUrl, "");
	assert.equal(g.branding, "");
	assert.equal(g.dataRegion, "");
	assert.equal(g.tenantDomain, "");
	assert.deepEqual(g.approvalOidc, { issuer: "", clientId: "", hasClientSecret: false, allowedSubjects: [], methods: ["password"] });
});

test("gates: only exact values turn on; typos and non-https URLs stay off", () => {
	const g = parseGates({
		DB: dummy, TENANCY: "Host", QUOTAS: "yes", USAGE_SINK: "log", WAKE_TARGET_POLICY: "https",
		BRANDING: "a2a", DATA_REGION: "us", SIGNUP_URL: "http://example.com", APPROVAL_OIDC_ISSUER: "http://example.com",
		APPROVAL_METHODS: "magic", TENANT_DOMAIN: ".Example.COM.",
	} as WorkerBindings).gates;
	assert.equal(g.tenancy, "single");
	assert.equal(g.quotas, false);
	assert.equal(g.usageSink, "");
	assert.equal(g.wakeTargetPolicy, "");
	assert.equal(g.branding, "");
	assert.equal(g.dataRegion, "");
	assert.equal(g.signupUrl, "");
	assert.equal(g.approvalOidc.issuer, "");
	assert.deepEqual(g.approvalOidc.methods, ["password"]);
	assert.equal(g.tenantDomain, "example.com");

	const on = parseGates({
		DB: dummy, TENANCY: "host", TENANT_DO: {} as any, QUOTAS: "on", USAGE_SINK: "d1",
		WAKE_TARGET_POLICY: "public-https", BRANDING: "hosted", DATA_REGION: "EU",
		SIGNUP_URL: "https://example.com/start", APPROVAL_OIDC_ISSUER: "https://example.com",
		APPROVAL_OIDC_CLIENT_ID: "client", APPROVAL_OIDC_CLIENT_SECRET: "secret",
		APPROVAL_OIDC_ALLOWED_SUBJECTS: " acct_1 , acct_2 ", APPROVAL_METHODS: "oidc,password",
		TENANT_DOMAIN: "example.com",
	} as WorkerBindings).gates;
	assert.equal(on.tenancy, "host");
	assert.equal(on.hostedStorage, true);
	assert.equal(on.quotas, true);
	assert.equal(on.usageSink, "d1");
	assert.equal(on.wakeTargetPolicy, "public-https");
	assert.equal(on.branding, "hosted");
	assert.equal(on.dataRegion, "eu");
	assert.equal(on.signupUrl, "https://example.com/start");
	assert.equal(on.approvalOidc.issuer, "https://example.com");
	assert.equal(on.approvalOidc.hasClientSecret, true);
	assert.deepEqual(on.approvalOidc.allowedSubjects, ["acct_1", "acct_2"]);
	assert.deepEqual(on.approvalOidc.methods, ["oidc", "password"]);
});

test("TENANCY=host without TENANT_DO does not flip hostedStorage", () => {
	assert.equal(parseGates({ DB: dummy, TENANCY: "host" } as WorkerBindings).gates.hostedStorage, false);
});

test("self-host peer key decrypts tokens sealed from OWNER_TOKEN, and ignores TENANT_SECRETS_KEY", async () => {
	const sealed = await sealPeerToken("owner-secret", "alpha", "peer-token");
	const ctx = resolveTenant(selfEnv({ TENANT_SECRETS_KEY: "platform-key-not-used", TENANCY: "host" }));
	assert.equal(ctx.mode, "single");
	assert.equal(ctx.id, "");
	const key = await ctx.peerKey();
	assert.ok(key);
	assert.equal(await openPeerTokenWithKey(key!, "alpha", sealed), "peer-token");
	assert.equal(await openPeerToken("owner-secret", "alpha", sealed), "peer-token");
	assert.equal(await ctx.peerKey(), key, "the key is derived once per context");
});

test("self-host owner check is OWNER_TOKEN equality and rejects a missing token before accepting anyone", async () => {
	const ctx = resolveTenant(selfEnv());
	assert.equal(await ctx.isOwner("Bearer owner-secret"), true);
	assert.equal(await ctx.isOwner("bearer owner-secret"), true);
	assert.equal(await ctx.isOwner("Bearer owner-secret "), true);
	assert.equal(await ctx.isOwner("Bearer other"), false);
	assert.equal(await ctx.isOwner(null), false);
	assert.equal(await ctx.isOwner("Basic owner-secret"), false);
	const none = resolveTenant(selfEnv({ OWNER_TOKEN: undefined }));
	assert.equal(await none.isOwner("Bearer owner-secret"), false);
	assert.equal(await none.peerKey(), null);
});

test("hosted owner check uses the token hash and never the platform OWNER_TOKEN", async () => {
	const token = "hosted-owner-token";
	const hash = await sha256(token);
	const ctx = hostedTenantContext(selfEnv({ TENANT_SECRETS_KEY: "platform-key" }), {
		id: "ten_a", db: dummy, publicUrl: "https://a.example.com", ownerTokenHash: hash.toUpperCase(),
	});
	assert.equal(ctx.mode, "host");
	assert.equal(await ctx.isOwner(`Bearer ${token}`), true);
	assert.equal(await ctx.isOwner("Bearer owner-secret"), false, "platform OWNER_TOKEN does not authenticate");
	assert.equal(await ctx.isOwner("Bearer wrong"), false);
	const bad = hostedTenantContext(selfEnv(), {
		id: "ten_a", db: dummy, publicUrl: "https://a.example.com", ownerTokenHash: "not-a-hash",
	});
	assert.equal(await bad.isOwner(`Bearer ${token}`), false);
	const missing = hostedTenantContext(selfEnv(), { id: "ten_a", db: dummy, publicUrl: "https://a.example.com" });
	assert.equal(await missing.isOwner(`Bearer ${token}`), false);
});

test("hosted peer key is HKDF(TENANT_SECRETS_KEY, tenant id) and does not open another tenant or a self-host seal", async () => {
	const env = selfEnv({ TENANT_SECRETS_KEY: "platform-key" });
	const a = hostedTenantContext(env, { id: "ten_a", db: dummy, publicUrl: "https://a.example.com", ownerTokenHash: "ab".repeat(32) });
	const b = hostedTenantContext(env, { id: "ten_b", db: dummy, publicUrl: "https://b.example.com", ownerTokenHash: "ab".repeat(32) });
	const keyA = await a.peerKey();
	assert.ok(keyA);
	const sealed = await sealPeerTokenWithKey(keyA!, "alpha", "peer-token");
	assert.equal(await openPeerTokenWithKey(keyA!, "alpha", sealed), "peer-token");
	assert.equal(await openPeerTokenWithKey((await b.peerKey())!, "alpha", sealed), null);
	assert.equal(await openPeerToken("owner-secret", "alpha", sealed), null);
	assert.equal(await openPeerToken("platform-key", "alpha", sealed), null);
	const selfSealed = await sealPeerToken("owner-secret", "alpha", "peer-token");
	assert.equal(await openPeerTokenWithKey(keyA!, "alpha", selfSealed), null);
	const noKey = hostedTenantContext(selfEnv(), { id: "ten_a", db: dummy, publicUrl: "https://a.example.com" });
	assert.equal(await noKey.peerKey(), null);
});

test("hosted config does not inherit Worker secrets; operational caps do inherit and can be overridden", () => {
	const ctx = hostedTenantContext(selfEnv({
		WAKE_WEBHOOK_URL: "https://hooks.example.net/wake", WAKE_WEBHOOK_KEY: "hook-key",
		UPSTREAM_TOKEN: "upstream", RATE_PER_MIN: "60", AGENT_NAME: "Platform name",
	}), {
		id: "ten_a", db: dummy, publicUrl: "https://a.example.com",
		config: { AGENT_NAME: "Tenant A", WAKE_WEBHOOK_URL: "https://hooks.example.net/a" },
	});
	assert.equal(ctx.AGENT_NAME, "Tenant A");
	assert.equal(ctx.PUBLIC_URL, "https://a.example.com");
	assert.equal(ctx.WAKE_WEBHOOK_URL, "https://hooks.example.net/a");
	assert.equal(ctx.WAKE_WEBHOOK_KEY, undefined);
	assert.equal(ctx.UPSTREAM_TOKEN, undefined);
	assert.equal(ctx.RATE_PER_MIN, "60");
	const capped = hostedTenantContext(selfEnv({ RATE_PER_MIN: "60" }), {
		id: "ten_a", db: dummy, publicUrl: "https://a.example.com", config: { RATE_PER_MIN: "10" },
	});
	assert.equal(capped.RATE_PER_MIN, "10");
});

test("DATA_REGION selects a DO jurisdiction only for eu and fedramp", () => {
	const calls: string[] = [];
	const ns = { id: "default", jurisdiction(loc: string) { calls.push(loc); return { id: loc, jurisdiction: ns.jurisdiction }; } };
	assert.equal(namespaceForRegion(ns, "").id, "default");
	assert.equal(namespaceForRegion(ns, "eu").id, "eu");
	assert.equal(namespaceForRegion(ns, "fedramp").id, "fedramp");
	assert.equal(namespaceForRegion(ns, "us").id, "default");
	assert.deepEqual(calls, ["eu", "fedramp"]);
	assert.equal(namespaceForRegion({ id: "plain" }, "eu").id, "plain");
});

test("fetch path: gates set or unset, the self-host Worker still answers from OWNER_TOKEN and env.DB", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const base = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox" };
	const gates = {
		TENANCY: "host", TENANT_SECRETS_KEY: "platform-key", TENANT_DOMAIN: "example.com", DATA_REGION: "eu",
		QUOTAS: "on", USAGE_SINK: "d1", WAKE_TARGET_POLICY: "public-https", SIGNUP_URL: "https://example.com",
		BRANDING: "hosted", APPROVAL_OIDC_ISSUER: "https://example.com", APPROVAL_OIDC_CLIENT_ID: "client",
		APPROVAL_OIDC_CLIENT_SECRET: "secret", APPROVAL_OIDC_ALLOWED_SUBJECTS: "acct_1", APPROVAL_METHODS: "oidc",
	};
	const call = async (env: Record<string, unknown>, path: string, headers: Record<string, string> = {}) => {
		const res = await worker.fetch(new Request(BASE + path, { headers }) as any, env as any, { waitUntil() {}, passThroughOnException() {} } as any);
		return { status: res.status, data: await res.json() as any };
	};
	const plain = await call(base, "/health");
	const reserved = await call({ ...base, ...gates }, "/health");
	const empty = await call({ ...base, TENANCY: "", QUOTAS: "", DATA_REGION: "", SIGNUP_URL: "" }, "/health");
	assert.deepEqual(plain.data, { ok: true, publicUrl: BASE, mode: "inbox", mcp: true });
	assert.deepEqual(reserved.data, plain.data);
	assert.deepEqual(empty.data, plain.data);

	const own = await call({ ...base, ...gates }, "/owner/inbox", { authorization: "Bearer owner-secret" });
	assert.equal(own.status, 200, JSON.stringify(own.data));
	const no = await call({ ...base, ...gates }, "/owner/inbox", { authorization: "Bearer platform-key" });
	assert.equal(no.status, 401);
});
