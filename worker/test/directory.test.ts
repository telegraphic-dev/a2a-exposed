// Name directory: host parsing and the 60s isolate cache. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearDirectoryCache, DIRECTORY_MAX, directoryKey, lookupDirectory, parseDirectoryEntry, TENANT_NAME, tenantNameFromHost, tenantRegion } from "../src/directory.ts";

test("tenant names are 4–32 characters and one label under the domain", () => {
	assert.equal(TENANT_NAME.test("abcd"), true);
	assert.equal(TENANT_NAME.test("abc"), false);
	assert.equal(TENANT_NAME.test("a".repeat(32)), true);
	assert.equal(TENANT_NAME.test("a".repeat(33)), false);
	assert.equal(TENANT_NAME.test("-abcd"), false);
	assert.equal(TENANT_NAME.test("abcd-"), false);
	assert.equal(tenantNameFromHost("abcd.example.com", "example.com"), "abcd");
	assert.equal(tenantNameFromHost("ABCD.Example.COM", "example.com"), "abcd");
	assert.equal(tenantNameFromHost("example.com", "example.com"), null);
	assert.equal(tenantNameFromHost("a.b.example.com", "example.com"), null);
	assert.equal(tenantNameFromHost("abcd.example.com.evil.example", "example.com"), null);
	assert.equal(tenantNameFromHost("abcd.example.org", "example.com"), null);
	assert.equal(tenantNameFromHost("abcd.example.com", ""), null);
});

test("directory entries need an id and a status; the region falls back to DATA_REGION", () => {
	assert.equal(parseDirectoryEntry(null), null);
	assert.equal(parseDirectoryEntry({ id: "../x", status: "active" }), null);
	assert.equal(parseDirectoryEntry({ id: "t1", status: "Active" }), null);
	const ok = parseDirectoryEntry({ id: "t1", status: "active", region: "eu", version: 3 });
	assert.deepEqual(ok, { id: "t1", status: "active", region: "eu", version: 3 });
	assert.equal(tenantRegion(ok!, ""), "eu");
	assert.equal(tenantRegion({ id: "t1", status: "active", region: "", version: 1 }, "fedramp"), "fedramp");
	assert.equal(tenantRegion({ id: "t1", status: "active", region: "", version: 1 }, ""), "");
});

test("lookups are cached for 60s, including unknown names", async () => {
	clearDirectoryCache();
	const store = new Map<string, string>();
	const kv = {
		async get(key: string, type?: string) {
			const v = store.get(key);
			if (v == null) return null;
			return type === "json" ? JSON.parse(v) : v;
		},
	};
	store.set(directoryKey("abcd"), JSON.stringify({ id: "t1", status: "active", region: "", version: 1 }));
	assert.equal((await lookupDirectory(kv, "abcd", 1_000))?.id, "t1");
	store.set(directoryKey("abcd"), JSON.stringify({ id: "t2", status: "suspended", region: "eu", version: 2 }));
	assert.equal((await lookupDirectory(kv, "abcd", 1_000 + 59_000))?.id, "t1", "still the cached row");
	assert.equal((await lookupDirectory(kv, "abcd", 1_000 + 60_000))?.status, "suspended");
	assert.equal(await lookupDirectory(kv, "nope", 0), null);
	store.set(directoryKey("nope"), JSON.stringify({ id: "t9", status: "active", region: "", version: 1 }));
	assert.equal(await lookupDirectory(kv, "nope", 30_000), null, "a miss stays cached");
	assert.equal((await lookupDirectory(kv, "nope", 60_000))?.id, "t9");
	clearDirectoryCache();
});

test("the directory cache evicts the oldest name once it is full", async () => {
	clearDirectoryCache();
	let gets = 0;
	const kv = { async get() { gets++; return null; } };
	for (let i = 0; i < DIRECTORY_MAX; i++) await lookupDirectory(kv, "k" + i, 1);
	assert.equal(gets, DIRECTORY_MAX);
	await lookupDirectory(kv, "overflow", 1);
	assert.equal(gets, DIRECTORY_MAX + 1);
	await lookupDirectory(kv, "k0", 1);
	assert.equal(gets, DIRECTORY_MAX + 2, "the oldest miss was evicted");
	await lookupDirectory(kv, "overflow", 1);
	assert.equal(gets, DIRECTORY_MAX + 2, "a name just stored is still cached");
	clearDirectoryCache();
});
