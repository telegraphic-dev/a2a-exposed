// Feedback scrubbing, the owner discovery route, and the hosted post. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { dispatch } from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { feedbackEndpoint, feedbackIssueUrl, scrubFeedbackText, sendFeedback } from "../src/feedback.ts";
import { hostedTenantContext, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";

function execution(): { ectx: ExecutionContext; done: () => Promise<unknown> } {
	const pending: Promise<unknown>[] = [];
	return {
		ectx: { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as ExecutionContext,
		done: () => Promise.allSettled(pending),
	};
}

function db() {
	return d1(new URL("../migrations/", import.meta.url));
}

function selfEnv(over: Record<string, unknown> = {}): WorkerBindings {
	return { DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Ada", ...over } as WorkerBindings;
}

async function call(env: WorkerBindings, path: string, headers: Record<string, string> = {}) {
	const run = execution();
	const res = await worker.fetch(new Request(BASE + path, { headers }), env, run.ectx);
	await run.done();
	const text = await res.text();
	let data: any = text;
	try { data = JSON.parse(text); } catch { /* html or empty */ }
	return { status: res.status, data, text };
}

test("scrubFeedbackText removes token shapes and Bearer values", () => {
	const token = "a2aow_" + "b".repeat(24);
	const text = scrubFeedbackText(`token ${token} and Bearer supersecretvalue stay out`);
	assert.equal(text.includes(token), false);
	assert.equal(text.includes("supersecretvalue"), false);
	assert.match(text, /\[redacted\]/);
	assert.match(text, /Bearer \[redacted\]/);
});

test("the fallback URL carries the title and body", () => {
	const url = new URL(feedbackIssueUrl("hi <there>", "line\nBearer supersecretvalue"));
	assert.equal(`${url.origin}${url.pathname}`, "https://github.com/telegraphic-dev/a2a-exposed/issues/new");
	assert.equal(url.searchParams.get("title"), "hi <there>");
	assert.match(url.searchParams.get("body") ?? "", /Bearer supersecretvalue/);
});

test("GET /owner/feedback is hosted only for a hosted tenant", async () => {
	const env = selfEnv({ FEEDBACK_URL: "https://control.example.com" });
	assert.equal((await call(env, "/owner/feedback")).status, 401);
	const owned = await call(env, "/owner/feedback", { authorization: "Bearer owner-secret" });
	assert.deepEqual(owned.data, { hosted: false });
	assert.equal(feedbackEndpoint(resolveTenant(env)), "");

	const hash = await sha256("owner-secret");
	const hostedEnv = selfEnv({
		FEEDBACK_URL: "https://control.example.com",
		TENANT_DOMAIN: "example.com",
		PUBLIC_URL: "https://northwind.example.com",
	});
	const ctx = hostedTenantContext(hostedEnv, {
		id: "t1", db: hostedEnv.DB, publicUrl: "https://northwind.example.com", ownerTokenHash: hash, config: { AGENT_NAME: "Ada" },
	});
	assert.equal(feedbackEndpoint(ctx), "https://control.example.com/api/feedback");
	const run = execution();
	const res = await dispatch(new Request("https://northwind.example.com/owner/feedback", {
		headers: { authorization: "Bearer owner-secret" },
	}), ctx, run.ectx);
	await run.done();
	assert.deepEqual(await res.json(), { hosted: true, url: "https://control.example.com/api/feedback" });
});

test("sendFeedback does not call out from a self-hosted inbox", async () => {
	const ctx = resolveTenant(selfEnv({ FEEDBACK_URL: "https://control.example.com" }));
	const result = await sendFeedback(ctx, { message: "hello", kind: "other", contact: "", version: "" }, () => {
		throw new Error("fetch should not run");
	});
	assert.equal(result.filed, false);
	assert.match(result.issue_url, /^https:\/\/github\.com\/telegraphic-dev\/a2a-exposed\/issues\/new\?/);
});

test("a hosted tenant posts through the control binding with the owner-token hash", async () => {
	const hash = await sha256("owner-secret");
	const seen: { host: string | null; auth: string | null; body: any }[] = [];
	const binding = {
		async fetch(input: RequestInfo | URL) {
			const req = input instanceof Request ? input : new Request(String(input));
			seen.push({ host: req.headers.get("host"), auth: req.headers.get("authorization"), body: await req.json() });
			return Response.json({ ok: true, issue_url: "https://github.com/telegraphic-dev/a2a-exposed/issues/4" });
		},
	};
	const token = "a2amcp_" + "c".repeat(24);
	const env = selfEnv({
		FEEDBACK_URL: "https://control.example.com",
		TENANT_DOMAIN: "example.com",
		PUBLIC_URL: "https://northwind.example.com",
		CONTROL_SERVICE: binding,
	});
	const ctx = hostedTenantContext(env, {
		id: "t1", db: env.DB, publicUrl: "https://northwind.example.com", ownerTokenHash: hash, config: { AGENT_NAME: "Ada" },
	});
	const result = await sendFeedback(ctx, { message: `broke ${token}`, kind: "bug", contact: "", version: "1" }, () => {
		throw new Error("public fetch should not run");
	});
	assert.equal(result.filed, true);
	assert.equal(result.issue_url, "https://github.com/telegraphic-dev/a2a-exposed/issues/4");
	assert.equal(seen.length, 1);
	assert.equal(seen[0].host, "control.example.com");
	assert.equal(seen[0].auth, `Bearer ${hash}`);
	assert.equal(seen[0].body.source, "mcp");
	assert.equal(seen[0].body.agent, "Ada");
	assert.equal(seen[0].body.message.includes(token), false);
	assert.match(seen[0].body.message, /\[redacted\]/);

	const missing = {
		async fetch() { return new Response("no", { status: 404 }); },
	};
	const again = hostedTenantContext({ ...env, CONTROL_SERVICE: missing }, {
		id: "t1", db: env.DB, publicUrl: "https://northwind.example.com", ownerTokenHash: hash,
	});
	const fell = await sendFeedback(again, { message: "still broken", kind: "bug", contact: "", version: "" });
	assert.equal(fell.filed, false);
	assert.match(fell.issue_url, /issues\/new\?/);
});

test("the landing page footer links to the repository", async () => {
	const env = selfEnv();
	const run = execution();
	const res = await worker.fetch(new Request(BASE + "/", { headers: { accept: "text/html" } }), env, run.ectx);
	await run.done();
	const html = await res.text();
	assert.match(html, /<footer class="w">Served by <a href="https:\/\/github\.com\/telegraphic-dev\/a2a-exposed">a2a-exposed<\/a>\.<\/footer>/);
	assert.equal(/<script|<link|<img|<iframe|src=/i.test(html), false);
});
