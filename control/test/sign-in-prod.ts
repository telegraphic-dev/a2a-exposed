import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "./sql.ts";

const origin = "https://control.example.com";
const turnstileSecret = "turnstile-secret-value";
const db = openDb();
const original = globalThis.fetch;

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

let siteverifyCalls = 0;
let siteverifyBudget = 0;
let siteverify: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
	siteverifyCalls += 1;
	if (siteverifyBudget <= 0) return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
	siteverifyBudget -= 1;
	return Response.json({ success: true });
};
globalThis.fetch = async (input, init) => {
	const url = requestUrl(input);
	if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) return siteverify(input, init);
	return original(input, init);
};

const app = createApp({
	AUTH_SECRET: "test-secret-test-secret-test-secret",
	DB: db,
	GITHUB_CLIENT_ID: "gh-id",
	GITHUB_CLIENT_SECRET: "gh-secret",
	TURNSTILE_SITE_KEY: "site-key",
	TURNSTILE_SECRET_KEY: turnstileSecret,
	ISSUER: origin,
}, { database: db });

async function post(ip: string) {
	const calls = siteverifyCalls;
	siteverifyBudget = 1;
	const response = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: {
			origin,
			"content-type": "application/x-www-form-urlencoded",
			cookie: "__cf_bm=abc",
			"cf-connecting-ip": ip,
		},
		body: "provider=github&cf-turnstile-response=widget-token",
	});
	assert.equal(siteverifyCalls - calls, 1);
	return response;
}

const first = await post("203.0.113.10");
assert.equal(first.status, 303);
const authorize = new URL(first.headers.get("location") ?? "");
assert.equal(authorize.origin, "https://github.com");
assert.equal(authorize.pathname, "/login/oauth/authorize");
assert.equal(authorize.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/github`);
assert.match(authorize.searchParams.get("scope") ?? "", /user:email/);

for (const ip of ["203.0.113.10", "203.0.113.10"]) {
	const again = await post(ip);
	assert.equal(new URL(again.headers.get("location") ?? "").origin, "https://github.com");
}
const limited = new URL((await post("203.0.113.10")).headers.get("location") ?? "", origin);
assert.equal(limited.pathname, "/app");
assert.equal(limited.searchParams.get("error"), "rate_limit");
const other = await post("203.0.113.11");
assert.equal(new URL(other.headers.get("location") ?? "").origin, "https://github.com");

const nullOriginCalls = siteverifyCalls;
siteverifyBudget = 1;
const nullOrigin = await app.request(`${origin}/app/sign-in`, {
	method: "POST",
	headers: {
		origin: "null",
		"sec-fetch-site": "same-origin",
		"content-type": "application/x-www-form-urlencoded",
		cookie: "__cf_bm=abc",
		"cf-connecting-ip": "203.0.113.15",
	},
	body: "provider=github&cf-turnstile-response=widget-token",
});
assert.equal(siteverifyCalls - nullOriginCalls, 1);
assert.equal(new URL(nullOrigin.headers.get("location") ?? "").origin, "https://github.com");
const crossCalls = siteverifyCalls;
const crossSite = await app.request(`${origin}/app/sign-in`, {
	method: "POST",
	headers: {
		origin: "null",
		"sec-fetch-site": "cross-site",
		"content-type": "application/x-www-form-urlencoded",
		cookie: "__cf_bm=abc",
		"cf-connecting-ip": "203.0.113.16",
	},
	body: "provider=github&cf-turnstile-response=widget-token",
});
assert.equal(siteverifyCalls, crossCalls);
assert.equal(new URL(crossSite.headers.get("location") ?? "", origin).searchParams.get("error"), "origin");

const apiCalls = siteverifyCalls;
siteverifyBudget = 1;
const api = await app.request(`${origin}/api/auth/sign-in/social`, {
	method: "POST",
	headers: {
		origin,
		"content-type": "application/json",
		cookie: "__cf_bm=abc",
		"cf-connecting-ip": "203.0.113.14",
		"x-captcha-response": "widget-token",
	},
	body: JSON.stringify({ provider: "github", callbackURL: "/app", errorCallbackURL: "/app" }),
});
assert.equal(siteverifyCalls - apiCalls, 1);
assert.equal(api.status, 200);
const apiBody = await api.json() as { url?: string };
assert.equal(new URL(apiBody.url ?? "").origin, "https://github.com");

siteverify = async () => {
	siteverifyCalls += 1;
	return Response.json({ success: false, "error-codes": ["invalid-input-secret"] }, { status: 400 });
};
const logged: string[] = [];
const previous = console.error;
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
try {
	const rejected = await post("203.0.113.12");
	const url = new URL(rejected.headers.get("location") ?? "", origin);
	assert.equal(url.pathname, "/app");
	assert.equal(url.searchParams.get("error"), "invalid-input-secret");
	const lines = logged.filter((line) => line.includes("social_sign_in_failed"));
	assert.ok(lines.some((line) => line.includes("\"code\":\"invalid-input-secret\"") && line.includes("\"status\":400")));
	assert.equal(lines.some((line) => line.includes("widget-token") || line.includes(turnstileSecret)), false);
} finally {
	console.error = previous;
}

const beforeDirect = siteverifyCalls;
const direct = await app.request(`${origin}/api/auth/sign-in/social`, {
	method: "POST",
	headers: { origin, "content-type": "application/json", "cf-connecting-ip": "203.0.113.13" },
	body: JSON.stringify({ provider: "github", callbackURL: "/app", errorCallbackURL: "/app" }),
});
assert.equal(siteverifyCalls, beforeDirect);
assert.equal(direct.status, 400);
const body = await direct.json() as { code?: string };
assert.equal(body.code, "MISSING_RESPONSE");
