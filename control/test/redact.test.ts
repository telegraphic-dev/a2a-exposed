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

test("redact keeps a Bearer value under 8 characters and removes one of 8", () => {
	assert.equal(redact(`Bearer ${"C".repeat(7)}`), `Bearer ${"C".repeat(7)}`);
	assert.equal(redact(`Bearer ${"C".repeat(8)}`), "Bearer [redacted]");
});

test("redact consumes a Bearer credential of 200 and 201 characters", () => {
	assert.equal(redact(`Bearer ${"A".repeat(200)}`), "Bearer [redacted]");
	const text = redact(`Bearer ${"A".repeat(201)}`);
	assert.equal(text, "Bearer [redacted]");
	assert.equal(text.includes("A"), false);
});

test("redact removes a short Basic credential and a long one", () => {
	assert.equal(redact("Basic dTpw"), "Basic [redacted]");
	const text = redact(`see Basic ${"E".repeat(201)} end`);
	assert.equal(text, "see Basic [redacted] end");
	assert.equal(text.includes("E"), false);
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

test("redact removes a whole quoted assignment value", () => {
	const doubles = redact('PASSWORD="first second"');
	assert.equal(doubles, "PASSWORD=[redacted]");
	assert.equal(doubles.includes("first"), false);
	assert.equal(doubles.includes("second"), false);
	const singles = redact("PASSWORD='first second'");
	assert.equal(singles, "PASSWORD=[redacted]");
	assert.equal(singles.includes("first"), false);
	const escaped = redact('PASSWORD="say \\"hi there\\"" tail');
	assert.equal(escaped, "PASSWORD=[redacted] tail");
	assert.equal(escaped.includes("there"), false);
	const singleEscaped = redact("PASSWORD='it\\'s a secret' tail");
	assert.equal(singleEscaped, "PASSWORD=[redacted] tail");
	assert.equal(singleEscaped.includes("secret"), false);
	assert.equal(redact('NAME="Ada Lovelace"'), 'NAME="Ada Lovelace"');
	assert.equal(redact("PASSWORD=onlyfirst second"), "PASSWORD=[redacted] second");
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

for (const value of [123456789, true, false, null, ["opaque-secret", { nested: [1, 2] }], { nested: ["opaque-secret", { text: 'escaped " quote } ]' }] }]) {
	test(`redact removes JSON secret value ${JSON.stringify(value)}`, () => {
		const input = `{"password":${JSON.stringify(value)},"name":"Ada"}`;
		const expected = '{"password":"[redacted]","name":"Ada"}';
		assert.equal(redact(input), expected);
		assert.equal(redact(`before ${input} after`), `before ${expected} after`);
		assert.equal(redact(`{"outer":${input},"token":${JSON.stringify(value)}}`), `{"outer":${expected},"token":"[redacted]"}`);
	});
}

test("redact decodes escaped JSON secret names and preserves ordinary JSON values", () => {
	assert.equal(redact(String.raw`{"pass\u0077ord": ["opaque-secret"]}`), String.raw`{"pass\u0077ord": "[redacted]"}`);
	const ordinary = '{"count":123,"enabled":true,"items":[1,2],"metadata":{"name":"Ada"},"empty":null}';
	assert.equal(redact(ordinary), ordinary);
});

for (const prefix of ["https://example.com/?", "https://example.com/#", "https://example.com/#/route?", "", "body: "]) {
	for (const name of ["%74oken", "%54oKeN", "api%5fkey", "access+token", "client%20secret", "%74oken%", "%FF%74oken", "%ZZ%74oken", "TOKEN", "%74", "%54", "T", "+t+"]) {
		test(`encoded parameter ${prefix}${name} through both public functions`, () => {
			const input = `${prefix}${name}=${BODY}&name=Ada`;
			const expected = `${prefix}${name}=[redacted]&name=Ada`;
			assert.equal(redact(input), expected);
			assert.deepEqual(sanitized({ text: input }), { text: expected });
		});
	}
}

test("malformed and ordinary encoded parameters remain safe and unchanged", () => {
	for (const input of ["?%ZZ=Ada", "?%FF=Ada", "?na%6De=Ada+Lovelace", "?%74=short", "name=Ada&%74oken=&city=Prague"]) {
		assert.equal(redact(input), input);
		assert.equal(sanitized({ text: input }).text, input);
	}
	const input = `?name=Ada&%74oken=${OPAQUE}#access+token=${OPAQUE}`;
	const expected = "?name=Ada&%74oken=[redacted]#access+token=[redacted]";
	assert.equal(redact(input), expected);
	assert.equal(sanitized({ text: input }).text, expected);
});

test("a redaction marker in an input value cannot hide its trailing secret", () => {
	for (const input of ["PASSWORD=[redacted]still-secret", "?token=[redacted]still-secret"]) {
		assert.equal(redact(input).includes("still-secret"), false);
		assert.equal(sanitized({ text: input }).text.includes("still-secret"), false);
	}
});

test("encoded parameter names also hide quoted values completely", () => {
	for (const value of ['"first second"', "'first second'", '"unterminated secret']) {
		const input = `?%74oken=${value}`;
		assert.equal(redact(input), "?%74oken=[redacted]");
		assert.equal(sanitized({ text: input }).text, "?%74oken=[redacted]");
	}
});

const nestedUrl = "https://example.com/?token=opaque-field-secret";
const cleanUrl = "https://example.com/?token=[redacted]";
const nestedCases: [string, string][] = [
	[`url=${nestedUrl}`, `url=${cleanUrl}`],
	[`url='${nestedUrl}'`, `url='${cleanUrl}'`],
	[`https://example.com/#url=${nestedUrl}&name=Ada`, `https://example.com/#url=${cleanUrl}&name=Ada`],
	[`body: url=${nestedUrl}&name=Ada`, `body: url=${cleanUrl}&name=Ada`],
	[`url=https://example.com/?next=${nestedUrl}`, `url=https://example.com/?next=${cleanUrl}`],
	['url=https://example.com/#token=opaque-field-secret', 'url=https://example.com/#token=[redacted]'],
];
for (let layers = 0; layers < 5; layers += 1) {
	let input = nestedUrl;
	let expected = cleanUrl;
	for (let layer = 0; layer < layers; layer += 1) {
		input = `next=${encodeURIComponent(input)}`;
		expected = `next=${encodeURIComponent(expected)}`;
	}
	nestedCases.push([`url=${input}&name=Ada`, `url=${expected}&name=Ada`]);
	nestedCases.push([JSON.stringify({ url: input, name: "Ada" }), JSON.stringify({ url: expected, name: "Ada" })]);
	nestedCases.push([JSON.stringify({ text: JSON.stringify({ url: input }) }), JSON.stringify({ text: JSON.stringify({ url: expected }) })]);
}
for (const [input, expected] of nestedCases) {
	test(`ordinary containers inspect embedded credentials: ${input}`, () => {
		assert.equal(redact(input), expected);
		assert.deepEqual(sanitized({ url: input }), { url: expected });
	});
}

test("ordinary nested and encoded values retain their content", () => {
	for (const input of ['url=https://example.com/?name=Ada', 'url=https%3A%2F%2Fexample.com%2F%3Fname%3DAda', JSON.stringify({ url: 'url=https://example.com/#name=Ada' })]) {
		assert.equal(redact(input), input);
		assert.deepEqual(sanitized({ url: input }), { url: input });
	}
});

test("query values consume backslashes that are part of a credential", () => {
	const input = String.raw`url=https://example.com/?token=opaque\remaining-secret&name=Ada`;
	const expected = "url=https://example.com/?token=[redacted]&name=Ada";
	assert.equal(redact(input), expected);
	assert.deepEqual(sanitized({ url: input }), { url: expected });
});

test("excessive nesting fails closed", () => {
	const input = 'url='.repeat(100) + nestedUrl;
	for (const output of [redact(input), sanitized({ url: input }).url]) {
		assert.equal(output.includes('opaque-field-secret'), false);
		assert.match(output, /redacted/);
	}
});

test("repeated encoding of labels and JSON escapes cannot hide parameters", () => {
	for (const input of [
		'url=https://example.com/?%2574oken=opaque-field-secret',
		String.raw`{"url":"url=https:\/\/example.com\/?\u0074oken=opaque-field-secret"}`,
		`url=${encodeURIComponent('https://example.com/#next=' + encodeURIComponent(nestedUrl))}`,
	]) {
		for (const output of [redact(input), sanitized({ url: input }).url]) {
			assert.equal(output.includes('opaque-field-secret'), false);
			assert.match(output, /redacted/);
		}
	}
});

test("nested setup parameters inspect quoted and repeatedly encoded values", () => {
	for (const item of ['"opaque-field-secret"', '%6Fpaque-field-secret', '%256Fpaque-field-secret']) {
		const input = `url=https://example.com/?t=${item}&name=Ada`;
		const expected = 'url=https://example.com/?t=[redacted]&name=Ada';
		assert.equal(redact(input), expected);
		assert.deepEqual(sanitized({ url: input }), { url: expected });
	}
});

test("a nested URL with a quoted credential is independently inspected", () => {
	for (const value of ['"opaque-field-secret"', "'opaque-field-secret'", '"opaque field secret"']) {
		const input = `url=https://example.com/?token=${value}&name=Ada`;
		const expected = 'url=https://example.com/?token=[redacted]&name=Ada';
		assert.equal(redact(input), expected);
		assert.deepEqual(sanitized({ url: input }), { url: expected });
	}
});

test("assignment whitespace and apostrophes preserve genuine following parameters", () => {
	for (const value of ['"first second"', "'first second'", "first", "first'second", 'first"second']) {
		const input = `PASSWORD= ${value}&name=Ada`;
		assert.equal(redact(input), "PASSWORD= [redacted]&name=Ada");
		assert.equal(sanitized({ message: input }).message, "PASSWORD= [redacted]&name=Ada");
	}
	assert.equal(redact("https://example.com/?password=first'second&name=Ada"), "https://example.com/?password=[redacted]&name=Ada");
	assert.equal(redact("?t=FakeSetupTokenValue'second&name=Ada"), "?t=[redacted]&name=Ada");
	assert.equal(redact("PASSWORD= &name=Ada"), "PASSWORD= &name=Ada");
});

test("adversarial cross product of credential names, values, and containers", () => {
	const labels = [
		"authorization", "proxy-authorization", "cookie", "set-cookie", "password", "passwd",
		"secret", "token", "apiKey", "access_token", "refresh_token", "id_token",
		"client_secret", "private_key", "hmac_secret", "credential", "credentials",
		"bearer", "webhook_key", "access_client_id", "access_client_secret",
	];
	const names = labels.flatMap((key) => [
		key, key.toUpperCase(), ...(key === "bearer" ? [] : [`OWNER_${key}`]), key.replace(/[-_]/g, "."),
		key.replace(/./g, (c) => `%${c.charCodeAt(0).toString(16)}`),
		key.replace(/./g, (c) => `%25${c.charCodeAt(0).toString(16)}`),
	]);
	const encodedValue = "leakAlpha".replace(/./g, (c) => `%${c.charCodeAt(0).toString(16)}`);
	const values = [
		encodedValue, encodedValue.replace(/%/g, "%25"),
		"leakAlpha", '"leakAlpha leakBeta"', "'leakAlpha leakBeta'",
		"leakAlpha'leakBeta", 'leakAlpha"leakBeta',
		String.raw`"leakAlpha \"leakBeta\""`, String.raw`'leakAlpha \'leakBeta'`,
		"leakAlpha%20leakBeta", "leakAlpha%2520leakBeta",
		"'leakAlpha'leakBeta", '"leakAlpha"leakBeta', String.raw`"leakAlpha"'leakBeta tail'`,
		"[redacted]'leakAlpha", '[redacted]"leakBeta', String.raw`leakAlpha\leakBeta`,
	];
	const containers = [
		(s: string) => s,
		(s: string) => `https://example.com/?${s}&name=Ada`,
		(s: string) => `body: name=Ada&${s}&city=Prague`,
		(s: string) => `url=https://example.com/?${s}&name=Ada`,
		(s: string) => `next=url=https://example.com/#${s}&name=Ada`,
		(s: string) => `url=${encodeURIComponent("https://example.com/?" + s)}&name=Ada`,
		(s: string) => `url=${encodeURIComponent(encodeURIComponent("https://example.com/?" + s))}`,
		(s: string) => JSON.stringify({ message: s }),
		(s: string) => JSON.stringify({ message: JSON.stringify({ url: s }) }),
		(s: string) => `token=otherLeak ${s} password%3DencodedLeak`,
	];
	for (const name of names) for (const value of values) for (const sep of ["=", "= ", " = ", "\t=\t", "=\n"]) {
		for (const container of containers) {
			const input = container(`${name}${sep}${value}`);
			for (const output of [redact(input), sanitized(input), sanitized({ message: input }).message]) {
				let decoded = output;
				for (let i = 0; i < 6; i += 1) {
					assert.doesNotMatch(decoded, /leakAlpha|leakBeta|otherLeak|encodedLeak/, input + " => " + output);
					try { decoded = decodeURIComponent(decoded); } catch { break; }
				}
			}
		}
	}
});

test("text redaction continues inspecting encoded secrets", () => {
	const input = JSON.stringify({ message: "token=first-secret password%3Dsecond-secret" });
	for (const output of [redact(input), sanitized({ message: input }).message]) {
		assert.doesNotMatch(decodeURIComponent(output), /first-secret|second-secret/);
	}
});

test("repeated encoded containers remain bounded and hide the credential", () => {
	let input = "?password=deeplyNestedSecret";
	for (let i = 0; i < 12; i += 1) input = "url=" + encodeURIComponent(input);
	for (const output of [redact(input), sanitized({ message: input }).message]) {
		assert.doesNotMatch(output, /deeplyNestedSecret/);
	}
});

test("encoding failures redact the whole affected span through both APIs", () => {
	for (const surrogate of ["\uD800", "\uDBFF", "\uDC00", "\uDFFF", "\uDC00\uD800"]) {
		const input = `${surrogate} password%3Dopaque`;
		assert.equal(redact(input), "[redacted]");
		assert.equal(sanitized(input), "[redacted]");
		assert.deepEqual(sanitized({ message: input }), { message: "[redacted]" });
		const nested = JSON.stringify({ message: input, name: "Ada" });
		assert.equal(redact(nested), JSON.stringify({ message: "[redacted]", name: "Ada" }));
	}
});

test("seeded UTF-16 fuzz: arbitrary strings never throw through either API", () => {
	let seed = 0x210c96;
	const random = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed >>> 0;
	};
	const fragments = ["%", "%ZZ", "%FF", "%ED%A0%80", "%C0%AF", "%E2%82", "%00", "%25", "%3D", "+", "\\", '"', "'", "&", "=", "?", "\n", "\uD800", "\uDFFF", "password", "token"];
	for (let i = 0; i < 2000; i += 1) {
		let input = "";
		const length = random() % 80;
		for (let j = 0; j < length; j += 1) {
			input += random() % 2 ? String.fromCharCode(random() & 0xffff) : fragments[random() % fragments.length];
		}
		const output = redact(input);
		assert.equal(typeof output, "string");
		assert.equal(sanitized(input), output);
		assert.deepEqual(sanitized({ message: input }), { message: output });
	}
});

test("malformed encoding and Unicode cannot hide injected credentials", () => {
	const damage = ["", "%", "%ZZ", "%FF", "%ED%A0%80", "%F0%80%80%AF", "%E2%82", "\uD800", "\uDFFF", "\uDC00\uD800", "😀"];
	const credentials = [
		"password=fuzzSecretAlpha", 'PASSWORD= "fuzzSecretAlpha fuzzSecretBeta"',
		"?token=fuzzSecretAlpha'fuzzSecretBeta&name=Ada",
		'{"password":["fuzzSecretAlpha",{"nested":"fuzzSecretBeta"}]}',
		"?%2574oken=fuzzSecretAlpha", "url=https://example.com/?token=fuzzSecretAlpha",
		"token=fuzzSecretBeta password%3DfuzzSecretAlpha",
		"Bearer fuzzSecretAlpha" + "A".repeat(201), "Basic dTpw",
	];
	const containers = [
		(s: string) => s,
		(s: string) => JSON.stringify({ message: s }),
		(s: string) => JSON.stringify({ message: JSON.stringify({ url: s }) }),
		(s: string) => "url=" + encodeURIComponent(JSON.stringify({ message: s })),
	];
	// Decode ASCII independently so invalid UTF-8 cannot hide an encoded leak
	// from the test oracle by making whole-string decodeURIComponent throw.
	const decodeAscii = (s: string) => s.replace(/%([0-7][0-9a-f])/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
	for (const bad of damage) for (const credential of credentials) {
		for (const container of containers) {
			for (const input of [container(`${bad} ${credential}`), container(`${credential} ${bad}`)]) {
				for (let output of [redact(input), sanitized(input), sanitized({ message: input }).message]) {
					for (let depth = 0; depth < 8; depth += 1) {
						assert.doesNotMatch(output, /fuzzSecretAlpha|fuzzSecretBeta|dTpw/, JSON.stringify(input));
						output = decodeAscii(output);
					}
				}
			}
		}
	}
});
