import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const ectx = { waitUntil() {}, passThroughOnException() {} };

test("owner HTTP auth challenges identify the owner realm on self-hosted and hosted tenants", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret" } as WorkerBindings;
	const hosted = hostedTenantContext({ ...env, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key" }, {
		id: "ten_test", db: DB, publicUrl: BASE, ownerTokenHash: await sha256("tenant-owner"),
	});
	for (const [ctx, token] of [[resolveTenant(env), "owner-secret"], [hosted, "tenant-owner"]] as const) {
		const call = (method: string, path: string, auth?: string) => dispatch(new Request(BASE + path, {
			method, headers: auth ? { authorization: auth } : {},
		}), ctx, ectx as any);
		for (const auth of [undefined, "Basic ignored", "Bearer wrong", "Bearer a2aow_peer", "Bearer a2amcp_connector"]) {
			for (const [method, path] of [["GET", "/owner/inbox"], ["POST", "/owner/tasks/missing/reply"], ["DELETE", "/owner/peers/missing"], ["GET", "/owner/not-a-route"], ["HEAD", "/owner/inbox"]]) {
				const res = await call(method, path, auth);
				assert.equal(res.status, 401, `${method} ${path}`);
				assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="owner"');
				assert.equal(await res.text(), method === "HEAD" ? "" : JSON.stringify({ error: "unauthorized" }));
			}
		}
		const ok = await call("GET", "/owner/inbox", `Bearer ${token}`);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("www-authenticate"), null);
		assert.deepEqual(await ok.json(), []);
		const missing = await call("GET", "/owner/not-a-route", `Bearer ${token}`);
		assert.equal(missing.status, 404);
		assert.equal(missing.headers.get("www-authenticate"), null);
	}
	const rpc = await runOwnerRpc(hosted, ectx as any, { accountId: "acct_test", method: "GET", path: "/owner/inbox" });
	assert.equal(rpc.status, 200, "trusted hosted RPC retains its existing authorization boundary");
});
