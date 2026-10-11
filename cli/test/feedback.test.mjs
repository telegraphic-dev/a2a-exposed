// feedback: hosted post, or a prefilled GitHub issue URL. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../lib/a2a.mjs";
import { runFeedback } from "../lib/feedback.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function run(args) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-feedback-"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|WAKE_)/.test(k)));
	env.A2A_CONFIG_DIR = dir;
	env.A2A_NO_UPDATE_CHECK = "1";
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => {
			fs.rmSync(dir, { recursive: true, force: true });
			resolve({ status, stdout, stderr });
		});
	});
}

test("with no inbox, feedback prints an encoded GitHub issue URL", async () => {
	const token = "a2aot_" + "a".repeat(24);
	const r = await run(["feedback", `saw ${token} then Bearer supersecretvalue`, "--kind", "bug", "--contact", "ada@example.com", "--steps", `1. ran ${token}`, "--expected", "a reply", "--actual", "nothing", "--agent", "Claude Code", "--environment", "local laptop"]);
	assert.equal(r.status, 0, r.stderr);
	const url = new URL(r.stdout.trim());
	assert.equal(`${url.origin}${url.pathname}`, "https://github.com/telegraphic-dev/a2a-exposed/issues/new");
	assert.match(url.searchParams.get("title") ?? "", /^\[bug\] saw /);
	const body = url.searchParams.get("body") ?? "";
	assert.match(body, /Source: cli/);
	assert.match(body, /Kind: bug/);
	assert.match(body, /## Contact\n\nada@example.com/);
	assert.match(body, /## Steps\n\n1\. ran \[redacted\]/);
	assert.match(body, /## Expected\n\na reply/);
	assert.match(body, /## Actual\n\nnothing/);
	assert.match(body, /## Agent\n\nClaude Code/);
	assert.match(body, new RegExp(
		`## Environment\\n\\nDeployment: self-hosted\\nConnection: polling\\nVersion: ${VERSION.replace(/\./g, "\\.")}\\nWhere: local laptop\\nOS: `,
	));
	assert.match(body, new RegExp(`Node: ${process.version.replace(/\./g, "\\.")}`));
	assert.equal(body.includes("## Mode"), false);
	assert.equal(body.includes(token), false);
	assert.equal(body.includes("supersecretvalue"), false);
	assert.match(body, /\[redacted\]/);
	assert.equal(r.stdout.split("\n").filter(Boolean).length, 1);
});

test("an unknown kind or connection is refused", async () => {
	const r = await run(["feedback", "hi", "--kind", "nope"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--kind must be bug, idea, or other/);
	const connection = await run(["feedback", "hi", "--connection", "socket"]);
	assert.equal(connection.status, 1);
	assert.match(connection.stderr, /--connection must be webhook, proxy, or polling/);
});

test("a hosted inbox posts, a 404 falls back, and a 429 does not", async () => {
	const token = "a2aot_" + "b".repeat(24);
	const base = { message: `hello ${token}`, kind: "idea", version: VERSION, baseUrl: "https://agent.example.com", ownerToken: "owner-secret" };
	const filed = "https://github.com/telegraphic-dev/a2a-exposed/issues/9";
	let posts = 0;
	const ok = await runFeedback({
		...base,
		fetchImpl: async (url, init) => {
			if (String(url).endsWith("/owner/feedback")) return Response.json({ hosted: true, url: "https://control.example.com/api/feedback", version: "0.7.0", connection: "webhook" });
			posts += 1;
			assert.equal(new Headers(init.headers).get("authorization"), "Bearer owner-secret");
			const body = JSON.parse(String(init.body));
			assert.equal(body.source, "cli");
			assert.equal(body.version, `${VERSION} (worker 0.7.0)`);
			assert.equal(body.kind, "idea");
			assert.equal(body.message.includes(token), false);
			assert.match(body.message, /\[redacted\]/);
			assert.equal(body.deployment, "hosted");
			assert.equal(body.connection, "webhook");
			assert.match(body.os, /\S/);
			assert.equal(body.node, process.version);
			return Response.json({ ok: true, issue_url: filed });
		},
	});
	assert.equal(ok.filed, true);
	assert.equal(ok.url, filed);
	assert.equal(posts, 1);

	const missing = await runFeedback({
		...base,
		fetchImpl: async () => new Response("no", { status: 404 }),
	});
	assert.equal(missing.filed, false);
	assert.match(missing.url, /^https:\/\/github\.com\/telegraphic-dev\/a2a-exposed\/issues\/new\?/);

	await assert.rejects(() => runFeedback({
		...base,
		fetchImpl: async (url) => String(url).endsWith("/owner/feedback")
			? Response.json({ hosted: true, url: "https://control.example.com/api/feedback" })
			: Response.json({ error: "rate_limit" }, { status: 429 }),
	}), (error) => error instanceof CliError && /too many/.test(error.message));

	const overridden = await runFeedback({
		...base,
		connection: "proxy",
		fetchImpl: async (url, init) => {
			if (String(url).endsWith("/owner/feedback")) return Response.json({ hosted: true, url: "https://control.example.com/api/feedback", version: "0.7.0", connection: "webhook" });
			const body = JSON.parse(String(init.body));
			assert.equal(body.connection, "proxy");
			assert.equal(body.deployment, "hosted");
			return Response.json({ ok: true, issue_url: filed });
		},
	});
	assert.equal(overridden.filed, true);
});
