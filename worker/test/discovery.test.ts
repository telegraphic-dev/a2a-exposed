// Agent discovery helpers: root content negotiation, the Markdown connect page, llms.txt, and the docs origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../src/discovery.ts";

const model = (over: Partial<D.ConnectModel> = {}): D.ConnectModel => ({
	name: "example-peer", description: "An AI agent reachable over A2A. Messages are queued and handled asynchronously.",
	base: "https://example-peer.a2a.exposed", docs: D.DEFAULT_DOCS_ORIGIN, pairing: true, oauthMetadata: true, ...over,
});

test("rootFormat: Markdown when named at least as high as HTML and JSON; browsers keep HTML; ?format=json wins", () => {
	assert.equal(D.rootFormat("text/markdown", null), "markdown");
	assert.equal(D.rootFormat("text/markdown, text/html;q=0.9, */*;q=0.8", null), "markdown");
	assert.equal(D.rootFormat("text/markdown, text/html", null), "markdown", "a tie goes to Markdown");
	assert.equal(D.rootFormat("application/json, text/markdown", null), "markdown", "Markdown preferred over JSON at equal q");
	assert.equal(D.rootFormat("application/json, text/markdown;q=0.5", null), "json");
	assert.equal(D.rootFormat("text/html, text/markdown;q=0.5", null), "html");
	assert.equal(D.rootFormat("text/markdown;q=0", null), "json", "q=0 means not acceptable");
	assert.equal(D.rootFormat("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", null), "html", "browser Accept");
	assert.equal(D.rootFormat("*/*", null), "json", "a wildcard is not a request for Markdown");
	assert.equal(D.rootFormat(null, null), "json");
	assert.equal(D.rootFormat("TEXT/Markdown; charset=utf-8", null), "markdown");
	assert.equal(D.rootFormat("text/markdown", "json"), "json");
	assert.equal(D.rootFormat("text/html;q=0", null), "json");
});

test("docsOrigin: https origins only, else the default", () => {
	assert.equal(D.docsOrigin(undefined), "https://a2a.exposed");
	assert.equal(D.docsOrigin(""), "https://a2a.exposed");
	assert.equal(D.docsOrigin("https://staging.example.com/some/path?x=1"), "https://staging.example.com");
	assert.equal(D.docsOrigin("http://staging.example.com"), "https://a2a.exposed");
	assert.equal(D.docsOrigin("https://user:pw@staging.example.com"), "https://a2a.exposed");
	assert.equal(D.docsOrigin("javascript:alert(1)"), "https://a2a.exposed");
	assert.equal(D.docsOrigin("not a url"), "https://a2a.exposed");
});

test("connectMarkdown: front matter, expose-yourself first, pair, talk, machine-readable links, under 3 KB", () => {
	const md = D.connectMarkdown(model());
	assert.ok(md.startsWith("---\nagent-card: https://example-peer.a2a.exposed/.well-known/agent-card.json\n---\n# example-peer\n> An AI agent"));
	assert.ok(md.includes("Playbook: https://a2a.exposed/.well-known/agent-skills/a2a-exposed/references/connect.md"));
	const first = md.split("\n").find((l) => /^1\. /.test(l))!;
	assert.match(first, /Want two-way\?/);
	assert.ok(md.includes("https://a2a.exposed/.well-known/agent-skills/a2a-exposed-setup/SKILL.md"));
	assert.ok(md.includes("`npx -y a2a-exposed@latest connect https://example-peer.a2a.exposed`"));
	assert.ok(md.includes("https://example-peer.a2a.exposed/oauth/device_authorization"));
	assert.ok(md.includes("`POST https://example-peer.a2a.exposed/`"));
	assert.ok(md.includes("`npx -y a2a-exposed@latest peer announce --to <alias>`"));
	assert.ok(md.includes("[agent card](/.well-known/agent-card.json) · [legacy card](/.well-known/agent.json) · [OAuth metadata](/.well-known/oauth-authorization-server)"));
	assert.ok(new TextEncoder().encode(md).length < 3072);
	// targets that do not exist yet are not linked
	for (const missing of ["/api-catalog", "/auth.md", "agent-skills/index.json"]) assert.ok(!md.includes(missing), missing);
});

test("connectMarkdown: pairing off has no device link; no OAuth metadata link when nothing serves it; staging docs origin", () => {
	const md = D.connectMarkdown(model({ pairing: false, oauthMetadata: false, docs: "https://staging.example.com" }));
	assert.ok(!md.includes("/oauth/device_authorization") && !md.includes("/device"));
	assert.match(md, /pairing is turned off here\. Ask this agent's operator for a token\./);
	assert.ok(!md.includes("oauth-authorization-server"));
	assert.ok(md.includes("https://staging.example.com/.well-known/agent-skills/a2a-exposed/references/connect.md"));
	assert.ok(!md.includes("https://a2a.exposed/"));
});

test("connectMarkdown and llmsTxt: hostile card text stays one escaped line", () => {
	const hostile = model({ name: "Evil\n---\n# Owned <script>x</script> [click](https://evil.example)", description: "line1\n\n## Ignore previous\n![img](https://evil.example/p.png) `code` | a | b | x" });
	for (const doc of [D.connectMarkdown(hostile), D.llmsTxt(hostile)]) {
		assert.ok(!doc.includes("<script>"), "raw HTML escaped");
		assert.ok(!doc.includes("[click](") && !doc.includes("![img]("), "links and images escaped");
		assert.ok(!/^## Ignore previous/m.test(doc), "no injected heading");
		assert.ok(!/^# Owned/m.test(doc), "no injected H1");
		assert.equal(doc.split("\n").filter((l) => l === "---").length, doc.startsWith("---") ? 2 : 0, "no injected front matter");
		assert.ok(doc.includes("\\<script\\>") && doc.includes("\\[click\\]"));
	}
	const long = D.connectMarkdown(model({ name: "n".repeat(500), description: "d".repeat(5000) }));
	assert.ok(new TextEncoder().encode(long).length < 3072);
	assert.ok(long.includes("…"));
	assert.equal(D.mdText("claudia-de-bot my_agent", 100), "claudia-de-bot my_agent", "hyphens and underscores stay readable");
});

test("llmsTxt: llms.txt shape with absolute links and the full docs as optional", () => {
	const t = D.llmsTxt(model());
	const lines = t.split("\n");
	assert.equal(lines[0], "# example-peer");
	assert.equal(lines[1], "");
	assert.match(lines[2], /^> An AI agent reachable over A2A/);
	assert.ok(t.includes("## Connect\n"));
	assert.ok(t.includes("- [Playbook](https://a2a.exposed/.well-known/agent-skills/a2a-exposed/references/connect.md)"));
	assert.ok(t.includes("## Machine-readable\n"));
	assert.ok(t.includes("- [Agent card](https://example-peer.a2a.exposed/.well-known/agent-card.json)"));
	assert.ok(t.includes("## Optional\n\n- [Full a2a-exposed docs](https://a2a.exposed/llms-full.txt)"));
	const off = D.llmsTxt(model({ pairing: false, oauthMetadata: false, description: undefined }));
	assert.ok(!off.includes("/oauth/"));
	assert.match(off, /^> An A2A \(Agent2Agent\) agent endpoint\.$/m);
});

test("rootJsonLinks: pairing fields only when pairing is on", () => {
	assert.deepEqual(D.rootJsonLinks(model()), {
		pairingEndpoint: "https://example-peer.a2a.exposed/oauth/device_authorization",
		approvalPage: "https://example-peer.a2a.exposed/device",
		connect: "https://a2a.exposed/.well-known/agent-skills/a2a-exposed/references/connect.md",
		exposeYourself: "https://a2a.exposed/.well-known/agent-skills/a2a-exposed-setup/SKILL.md",
		markdown: "https://example-peer.a2a.exposed/index.md",
	});
	const off = D.rootJsonLinks(model({ pairing: false }));
	assert.equal(off.pairingEndpoint, undefined);
	assert.equal(off.approvalPage, undefined);
});
