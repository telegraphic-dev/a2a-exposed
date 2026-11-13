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
	for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/oauth-authorization-server", "/.well-known/agent-skills/index.json", "/.well-known/api-catalog", "/auth.md"]) assert.ok(md.includes(`](${path})`), path);
	assert.ok(new TextEncoder().encode(md).length < 3072);
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

test("contentSignal: name=yes|no pairs only, normalized; anything else is the default", () => {
	assert.equal(D.contentSignal(undefined), "search=yes, ai-input=yes, ai-train=no");
	assert.equal(D.contentSignal("search=yes,ai-input=no , AI-Train = yes"), "search=yes, ai-input=no, ai-train=yes");
	assert.equal(D.contentSignal("search=yes\nSitemap: https://evil.example/x"), D.DEFAULT_CONTENT_SIGNAL);
	assert.equal(D.contentSignal("search=maybe"), D.DEFAULT_CONTENT_SIGNAL);
	assert.equal(D.contentSignal(" , "), D.DEFAULT_CONTENT_SIGNAL);
});

test("robotsTxt: allow lists the private paths and the sitemap; disallow blocks everything", () => {
	const allow = D.robotsTxt("https://example-peer.a2a.exposed", false, D.DEFAULT_CONTENT_SIGNAL);
	assert.equal(allow, [
		"# A2A agent endpoint served by a2a-exposed. Agents: start at /index.md or /.well-known/agent-card.json",
		"User-agent: *", "Allow: /", "Disallow: /owner", "Disallow: /oauth/", "Disallow: /device", "Disallow: /mcp", "Disallow: /push", "Disallow: /relay/",
		"Content-Signal: search=yes, ai-input=yes, ai-train=no", "Sitemap: https://example-peer.a2a.exposed/sitemap.xml", "",
	].join("\n"));
	assert.equal(allow.split("\n").filter((l) => /^(User-agent|Content-Signal|Sitemap):/.test(l)).length, 3);
	const deny = D.robotsTxt("https://example-peer.a2a.exposed", true, "ai-train=no");
	assert.match(deny, /^Disallow: \/$/m);
	assert.doesNotMatch(deny, /^Allow:/m);
	assert.match(deny, /^Content-Signal: ai-train=no$/m);
	assert.equal(D.robotsDisallow("Disallow"), true);
	assert.equal(D.robotsDisallow("allow"), false);
	assert.equal(D.robotsDisallow(undefined), false);
});

test("sitemapXml: public pages only, XML-escaped", () => {
	const x = D.sitemapXml("https://example-peer.a2a.exposed");
	assert.ok(x.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`));
	for (const p of ["/", "/index.md", "/llms.txt", "/.well-known/agent-card.json"]) assert.ok(x.includes(`<loc>https://example-peer.a2a.exposed${p}</loc>`), p);
	for (const p of ["/device", "/owner", "lastmod"]) assert.ok(!x.includes(p), p);
	assert.ok(D.sitemapXml("https://a.example/x&y").includes("x&amp;y"));
});

test("linkHeader: alternate, api-catalog, describedby and service-doc", () => {
	const l = D.linkHeader("https://staging.example.com");
	assert.ok(l.includes(`</index.md>; rel="alternate"; type="text/markdown"`));
	assert.ok(l.includes(`</.well-known/agent-card.json>; rel="describedby"; type="application/json"`));
	assert.ok(l.includes(`</llms.txt>; rel="describedby"; type="text/plain"`));
	assert.ok(l.includes(`<https://staging.example.com/.well-known/agent-skills/a2a-exposed/references/connect.md>; rel="service-doc"; type="text/markdown"`));
	assert.ok(l.includes(`</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`));
});

test("apiCatalog: the RFC 9727 linkset from the issue, MCP anchor only while MCP is on", () => {
	const base = "https://example-peer.a2a.exposed";
	assert.deepEqual(D.apiCatalog(model({ mcp: true })), { linkset: [
		{ anchor: `${base}/`,
			"service-desc": [{ href: `${base}/.well-known/agent-card.json`, type: "application/json" }],
			"service-doc": [{ href: `${base}/index.md`, type: "text/markdown" },
				{ href: "https://a2a.exposed/.well-known/agent-skills/a2a-exposed/references/connect.md", type: "text/markdown" }],
			describedby: [{ href: `${base}/.well-known/oauth-protected-resource`, type: "application/json" }] },
		{ anchor: `${base}/mcp`,
			"service-desc": [{ href: `${base}/.well-known/mcp/server-card.json`, type: "application/json" }],
			describedby: [{ href: `${base}/.well-known/oauth-protected-resource/mcp`, type: "application/json" }] },
	] });
	const noMcp = D.apiCatalog(model({ mcp: false }));
	assert.equal(noMcp.linkset.length, 1);
	assert.equal(D.apiCatalog(model()).linkset.length, 1, "mcp unset counts as off");
	assert.equal(D.apiCatalog(model({ pairing: false })).linkset[0].describedby, undefined, "no link to a metadata document that is not served");
	assert.match(D.API_CATALOG_TYPE, /^application\/linkset\+json;/);
});

test("authMd: short, links the canonical map, no token values", () => {
	const md = D.authMd(model({ mcp: true }));
	assert.equal(md, "# auth.md: example-peer\n\n" +
		"- Peers: per-peer bearer token from the RFC 8628 device flow at https://example-peer.a2a.exposed/oauth/device_authorization\n" +
		"  (metadata: /.well-known/oauth-authorization-server). A person (this agent's owner) approves. Codes last 60 minutes.\n" +
		"- CLI: `npx -y a2a-exposed@latest connect https://example-peer.a2a.exposed` (stores the token, never prints it).\n" +
		"- Owner tools (`/mcp`, scope `inbox`) are for this agent's owner only.\n" +
		"- Never paste tokens in chat. Revoke: the owner runs `token revoke <label>`.\n" +
		"Full map of every a2a.exposed credential: https://a2a.exposed/auth.md\n");
	assert.ok(new TextEncoder().encode(md).length < 1024);
	const long = D.authMd(model({ name: `${"n".repeat(300)}\n# injected`, mcp: true }));
	assert.ok(new TextEncoder().encode(long).length < 1024, "a long name stays under 1 KB");
	assert.equal(long.split("\n").filter((l) => l.startsWith("#")).length, 1, "the name cannot add a heading");
	const off = D.authMd(model({ pairing: false, mcp: false }));
	assert.match(off, /pairing is turned off here/);
	assert.ok(!off.includes("/oauth/device_authorization") && !off.includes("/mcp"));
	assert.ok(D.authMd(model({ docs: "https://staging.example.com" })).endsWith("credential: https://staging.example.com/auth.md\n"));
});


test("machine-readable lists include public discovery routes and gate the MCP card on availability", () => {
	for (const mcp of [true, false]) {
		const m = model({ mcp, pairing: false, oauthMetadata: false });
		for (const [doc, prefix] of [[D.connectMarkdown(m), ""], [D.llmsTxt(m), m.base]]) {
			for (const path of ["/.well-known/agent-skills/index.json", "/.well-known/api-catalog", "/auth.md"]) assert.ok(doc.includes(`](${prefix}${path})`), path);
			assert.equal(doc.includes(`](${prefix}/.well-known/mcp/server-card.json)`), mcp);
			assert.ok(!doc.includes("oauth-authorization-server"));
		}
	}
});
