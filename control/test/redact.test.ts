// Fake values only. Each shape that leaked on 0.8.27 has its own test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, sanitized } from "../src/core/redact.ts";

const BODY = "FakePeerTokenValue0001";
const OPAQUE = "opaque-field-secret";

function hides(secret: string, text: string): void {
	assert.equal(text.includes(secret), false, text);
	assert.equal(text.includes(BODY), false, text);
	assert.match(text, /\[redacted\]/);
}

test("redact removes an a2aow_ peer token", () => {
	const secret = `a2aow_${BODY}`;
	const text = redact(`before ${secret} after`);
	hides(secret, text);
	assert.equal(text, "before [redacted] after");
});

test("redact removes an s2a_ token", () => {
	const secret = `s2a_${BODY}`;
	const text = redact(`before ${secret} after`);
	hides(secret, text);
	assert.equal(text, "before [redacted] after");
});

test("redact removes an a2amcp_ token", () => {
	const secret = `a2amcp_${BODY}`;
	const text = redact(`before ${secret} after`);
	hides(secret, text);
	assert.equal(text, "before [redacted] after");
});

test("redact removes an a2amcpr_ token", () => {
	const secret = `a2amcpr_${BODY}`;
	const text = redact(`before ${secret} after`);
	hides(secret, text);
	assert.equal(text, "before [redacted] after");
});

test("redact removes an a2aot_ owner token", () => {
	const secret = `a2aot_${BODY}`;
	const text = redact(`before ${secret} after`);
	hides(secret, text);
	assert.equal(text, "before [redacted] after");
});

test("redact removes a Bearer credential", () => {
	const secret = "FakeBearerSecretValue";
	const text = redact(`see Bearer ${secret} end`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, "see Bearer [redacted] end");
});

test("redact removes a JWT", () => {
	const secret = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI0MjQyIn0.sigvalue1234567890";
	const text = redact(`see ${secret} end`);
	assert.equal(text.includes(secret), false);
	assert.equal(text.includes("eyJ"), false);
	assert.equal(text, "see [redacted] end");
});

test("redact removes a PEM private key", () => {
	const secret = [
		"-----BEGIN PRIVATE KEY-----",
		"ZmFrZS1rZXktbWF0ZXJpYWw=",
		"-----END PRIVATE KEY-----",
	].join("\n");
	const text = redact(`see ${secret} end`);
	assert.equal(text.includes("ZmFrZS1rZXktbWF0ZXJpYWw="), false);
	assert.equal(text.includes("BEGIN PRIVATE KEY"), false);
	assert.equal(text, "see [redacted] end");
});

test("redact removes URL userinfo", () => {
	const secret = "user:fakepass";
	const text = redact(`see https://${secret}@agent.example.com/card end`);
	assert.equal(text.includes(secret), false);
	assert.equal(text.includes("fakepass"), false);
	assert.equal(text, "see https://[redacted]@agent.example.com/card end");
});

test("redact removes a setup secret", () => {
	const secret = "setupsecrettokenvalue";
	const text = redact(`see https://agent.example.com/device?t=${secret} end`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, "see https://agent.example.com/device?t=[redacted] end");
});

test("redact removes a ghp_ API key", () => {
	const secret = "ghp_testtokenvalue1234567890";
	const text = redact(`see ${secret} end`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, "see [redacted] end");
});

test("redact removes an authorization assignment", () => {
	const secret = "FakeHeaderSecretValue";
	const text = redact(`authorization: ${secret}`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, "authorization: [redacted]");
});

test("redact removes an env assignment whose name is a secret", () => {
	const secret = "opaque-env-secret";
	const text = redact(`OWNER_TOKEN=${secret}`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, "OWNER_TOKEN=[redacted]");
});

test("redact removes a JSON secret field", () => {
	const secret = OPAQUE;
	const text = redact(`{"password":"${secret}","name":"Ada"}`);
	assert.equal(text.includes(secret), false);
	assert.equal(text, '{"password":"[redacted]","name":"Ada"}');
});

test("sanitized redacts a name/value secret pair", () => {
	const secret = "opaque-name-value-secret";
	const input = { name: "Authorization", value: secret, note: "kept" };
	const out = sanitized(input);
	assert.equal(out.name, "Authorization");
	assert.equal(out.value, "[redacted]");
	assert.equal(out.note, "kept");
	assert.equal(JSON.stringify(out).includes(secret), false);
	assert.equal(input.value, secret);
});

test("sanitized redacts a key/value secret pair", () => {
	const secret = "opaque-key-value-secret";
	const input = { key: "WAKE_HMAC_SECRET", value: secret, note: "kept" };
	const out = sanitized(input);
	assert.equal(out.key, "WAKE_HMAC_SECRET");
	assert.equal(out.value, "[redacted]");
	assert.equal(out.note, "kept");
	assert.equal(JSON.stringify(out).includes(secret), false);
	assert.equal(input.value, secret);
});

test("sanitized redacts a name/value tuple", () => {
	const secret = "opaque-tuple-secret";
	const input = ["client_secret", secret] as const;
	const out = sanitized(input);
	assert.deepEqual(out, ["client_secret", "[redacted]"]);
	assert.equal(input[1], secret);
});

test("sanitized redacts secret field names and leaves ordinary fields", () => {
	const secret = OPAQUE;
	const input = {
		name: "Ada",
		title: "hello",
		note: "see the card",
		url: "https://agent.example.com/card",
		preset: "generic",
		email: "ada@example.com",
		session: "morning",
		password: secret,
		token: secret,
		secret,
		authorization: secret,
		apiKey: secret,
		access_token: secret,
		refresh_token: secret,
		client_secret: secret,
		private_key: secret,
		headers: [
			{ name: "Content-Type", value: "application/json" },
			{ name: "Authorization", value: secret },
		],
		env: [
			["PATH", "/usr/bin"],
			["OWNER_TOKEN", secret],
		],
		theme: { key: "theme", value: "dark" },
		city: { name: "city", value: "Prague" },
		label: ["label", "ada"],
	};
	const out = sanitized(input);
	assert.equal(out.name, "Ada");
	assert.equal(out.title, "hello");
	assert.equal(out.note, "see the card");
	assert.equal(out.url, "https://agent.example.com/card");
	assert.equal(out.preset, "generic");
	assert.equal(out.email, "ada@example.com");
	assert.equal(out.session, "morning");
	assert.equal(out.password, "[redacted]");
	assert.equal(out.token, "[redacted]");
	assert.equal(out.secret, "[redacted]");
	assert.equal(out.authorization, "[redacted]");
	assert.equal(out.apiKey, "[redacted]");
	assert.equal(out.access_token, "[redacted]");
	assert.equal(out.refresh_token, "[redacted]");
	assert.equal(out.client_secret, "[redacted]");
	assert.equal(out.private_key, "[redacted]");
	assert.deepEqual(out.headers[0], { name: "Content-Type", value: "application/json" });
	assert.deepEqual(out.headers[1], { name: "Authorization", value: "[redacted]" });
	assert.deepEqual(out.env[0], ["PATH", "/usr/bin"]);
	assert.deepEqual(out.env[1], ["OWNER_TOKEN", "[redacted]"]);
	assert.deepEqual(out.theme, { key: "theme", value: "dark" });
	assert.deepEqual(out.city, { name: "city", value: "Prague" });
	assert.deepEqual(out.label, ["label", "ada"]);
	assert.equal(JSON.stringify(out).includes(secret), false);
	assert.equal(input.password, secret);
});

test("redact leaves ordinary text", () => {
	const samples = [
		"hello Ada",
		"the token is unset",
		"authorization server",
		"authorization: none",
		"session=morning",
		"Bearer hi",
		"https://agent.example.com/card",
		"ada@example.com",
		"PORT=8787",
		"NAME=Ada",
		"https://agent.example.com/device?t=short",
		'{"name":"Ada","title":"hello","url":"https://agent.example.com/card","key":"theme","value":"dark"}',
	];
	for (const sample of samples) assert.equal(redact(sample), sample, sample);
});
