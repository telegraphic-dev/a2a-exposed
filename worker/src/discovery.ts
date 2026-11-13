// Agent discovery for a visitor who was told "connect to <this URL>": the Markdown root (GET / with Accept: text/markdown,
// /index.md), /llms.txt, and the links the JSON and HTML roots add. Pure helpers, so they run in Workers and in Node tests.
// Everything shown comes from the served (already scrubbed) agent card; the detail stays in the canonical skill.
import { DEFAULT_CLI } from "./pairing.ts";

/** Where the playbook and the setup skill are served. DISCOVERY_DOCS_ORIGIN overrides it (hosted staging links to
 *  staging); anything that is not an https origin falls back to this default. */
export const DEFAULT_DOCS_ORIGIN = "https://a2a.exposed";

export function docsOrigin(v: string | undefined): string {
	const s = (v || "").trim();
	if (!s) return DEFAULT_DOCS_ORIGIN;
	try {
		const u = new URL(s);
		if (u.protocol !== "https:" || u.username || u.password) return DEFAULT_DOCS_ORIGIN;
		return u.origin;
	} catch { return DEFAULT_DOCS_ORIGIN; }
}

export type DocsLinks = { connect: string; exposeYourself: string; llmsFull: string };

export function docsLinks(origin: string): DocsLinks {
	return {
		connect: `${origin}/.well-known/agent-skills/a2a-exposed/references/connect.md`,
		exposeYourself: `${origin}/.well-known/agent-skills/a2a-exposed-setup/SKILL.md`,
		llmsFull: `${origin}/llms-full.txt`,
	};
}

/** q value of each media range an Accept header names explicitly (wildcards are not counted). */
function acceptQ(accept: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const part of accept.split(",")) {
		const [type, ...params] = part.trim().split(";");
		const t = (type || "").trim().toLowerCase();
		if (!t) continue;
		let q = 1;
		for (const p of params) {
			const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
			if (m) { const n = Number(m[1]); q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }
		}
		out.set(t, Math.max(out.get(t) ?? 0, q));
	}
	return out;
}

/** Which representation of GET / to serve. Markdown when the client names text/markdown at least as high as both
 *  text/html and application/json (Markdown wins a tie); HTML when it names text/html; otherwise the JSON it always got. */
export function rootFormat(accept: string | null, formatParam: string | null): "json" | "html" | "markdown" {
	if (formatParam === "json") return "json";
	const q = acceptQ(accept || "");
	const md = q.get("text/markdown") ?? 0;
	const html = q.get("text/html") ?? 0;
	const json = q.get("application/json") ?? 0;
	if (md > 0 && md >= html && md >= json) return "markdown";
	if (html > 0) return "html";
	return "json";
}

/** One line of card text, safe in Markdown: whitespace and control characters collapsed to one line (so nothing
 *  can start a heading, list, or front matter), length capped, and the characters that open links, images, raw
 *  HTML, code, tables, or emphasis backslash-escaped. Hyphens and underscores stay readable (agent-name, my_agent). */
export function mdText(v: string, max: number): string {
	let s = String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
	if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
	return s.replace(/[\\`*\[\]<>|]/g, (c) => "\\" + c);
}

export type ConnectModel = {
	name: string;
	description?: string;
	base: string; // PUBLIC_URL, no trailing slash
	docs: string; // docsOrigin(DISCOVERY_DOCS_ORIGIN)
	pairing: boolean; // device-flow pairing is on
	oauthMetadata: boolean; // /.well-known/oauth-authorization-server is served (pairing or MCP on)
	mcp?: boolean; // the owner MCP at /mcp is on (not MCP=off, not proxy mode)
};

const NAME_MAX = 100;
const DESCRIPTION_MAX = 400;

function pairStep(m: ConnectModel): string {
	if (!m.pairing) return `2. **Pair**: pairing is turned off here. Ask this agent's operator for a token.`;
	return `2. **Pair**: \`${DEFAULT_CLI} connect ${m.base}\`, or without the CLI the RFC 8628\n` +
		`   device flow at ${m.base}/oauth/device_authorization (see \`securitySchemes.pairing\` in the card).\n` +
		`   A person approves; never paste tokens in chat.`;
}

function steps(m: ConnectModel, name: string, links: DocsLinks): string {
	return `1. **Want two-way?** Pairing is one-way: after step 2 you can message ${name}, but it can only reply on your task.\n` +
		`   If you have no public A2A address, offer your human to get one first (hosted or self-hosted):\n` +
		`   ${links.exposeYourself}\n` +
		`${pairStep(m)}\n` +
		`3. **Talk**: A2A JSON-RPC \`POST ${m.base}/\` (A2A 1.0 and 0.3; async, use GetTask).\n` +
		`   If you exposed yourself: \`${DEFAULT_CLI} peer announce --to <alias>\`.`;
}

function machineLinks(m: ConnectModel): { label: string; href: string }[] {
	const out = [
		{ label: "agent card", href: "/.well-known/agent-card.json" },
		{ label: "legacy card", href: "/.well-known/agent.json" },
		{ label: "skills index", href: "/.well-known/agent-skills/index.json" },
		{ label: "API catalog", href: "/.well-known/api-catalog" },
		{ label: "authentication", href: "/auth.md" },
	];
	if (m.mcp) out.push({ label: "MCP server card", href: "/.well-known/mcp/server-card.json" });
	if (m.oauthMetadata) out.push({ label: "OAuth metadata", href: "/.well-known/oauth-authorization-server" });
	return out;
}

/** GET / (Accept: text/markdown) and GET /index.md: where this is and the three connect steps, under 3 KB. */
export function connectMarkdown(m: ConnectModel): string {
	const name = mdText(m.name, NAME_MAX) || "A2A agent";
	const links = docsLinks(m.docs);
	const desc = m.description ? `> ${mdText(m.description, DESCRIPTION_MAX)}\n` : "";
	return `---\nagent-card: ${m.base}/.well-known/agent-card.json\n---\n# ${name}\n${desc}\n` +
		`You were asked to connect to this agent. Playbook: ${links.connect}\n\n` +
		`${steps(m, name, links)}\n\n` +
		`Machine-readable: ${machineLinks(m).map((l) => `[${l.label}](${l.href})`).join(" · ")}\n`;
}

/** GET /llms.txt: the same content in llms.txt shape (H1, summary, sections of links). Absolute links: the file is
 *  often read out of context. The full project docs are linked, not copied per agent. */
export function llmsTxt(m: ConnectModel): string {
	const name = mdText(m.name, NAME_MAX) || "A2A agent";
	const links = docsLinks(m.docs);
	const summary = m.description ? mdText(m.description, DESCRIPTION_MAX) : "An A2A (Agent2Agent) agent endpoint.";
	return `# ${name}\n\n> ${summary}\n\n` +
		`You were asked to connect to this agent. Follow the steps below; the playbook has the detail.\n\n` +
		`## Connect\n\n` +
		`- [Playbook](${links.connect}): how to connect to an agent from its URL\n` +
		`- [Want two-way? Get your own A2A address first](${links.exposeYourself}): pairing is one-way, so ${name} can only reply on your task until you have one\n` +
		(m.pairing
			? `- [Pair](${m.base}/oauth/device_authorization): \`${DEFAULT_CLI} connect ${m.base}\`, or the RFC 8628 device flow; a person approves\n`
			: `- Pair: pairing is turned off here. Ask this agent's operator for a token.\n`) +
		`- [Talk](${m.base}/): A2A JSON-RPC POST (A2A 1.0 and 0.3; async, use GetTask)\n\n` +
		`## Machine-readable\n\n` +
		machineLinks(m).map((l) => `- [${l.label[0].toUpperCase()}${l.label.slice(1)}](${m.base}${l.href})\n`).join("") +
		`\n## Optional\n\n- [Full a2a-exposed docs](${links.llmsFull})\n`;
}

/** Fields the JSON root adds for agents (existing fields unchanged). */
export function rootJsonLinks(m: ConnectModel): Record<string, string | undefined> {
	const links = docsLinks(m.docs);
	return {
		pairingEndpoint: m.pairing ? `${m.base}/oauth/device_authorization` : undefined,
		approvalPage: m.pairing ? `${m.base}/device` : undefined,
		connect: links.connect,
		exposeYourself: links.exposeYourself,
		markdown: `${m.base}/index.md`,
	};
}

/** RFC 9727 media type of /.well-known/api-catalog: a linkset (RFC 9264) with the API catalog profile. */
export const API_CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

type CatalogLink = { href: string; type: string };

/** GET /.well-known/api-catalog (RFC 9727): one anchor per API this agent serves. The A2A JSON-RPC API at / always;
 *  the owner MCP at /mcp only while MCP is on. Each OAuth metadata link only where that document is served. */
export function apiCatalog(m: ConnectModel): { linkset: Record<string, string | CatalogLink[]>[] } {
	const links = docsLinks(m.docs);
	const root: Record<string, string | CatalogLink[]> = {
		anchor: `${m.base}/`,
		"service-desc": [{ href: `${m.base}/.well-known/agent-card.json`, type: "application/json" }],
		"service-doc": [{ href: `${m.base}/index.md`, type: "text/markdown" }, { href: links.connect, type: "text/markdown" }],
	};
	if (m.pairing) root.describedby = [{ href: `${m.base}/.well-known/oauth-protected-resource`, type: "application/json" }];
	const linkset = [root];
	if (m.mcp) linkset.push({
		anchor: `${m.base}/mcp`,
		"service-desc": [{ href: `${m.base}/.well-known/mcp/server-card.json`, type: "application/json" }],
		describedby: [{ href: `${m.base}/.well-known/oauth-protected-resource/mcp`, type: "application/json" }],
	});
	return { linkset };
}

/** GET /auth.md and /.well-known/auth.md: how a visitor gets a credential for this agent, in a few lines. It names
 *  endpoints and commands only, never a token value, and links the full a2a.exposed credential map. Under 1 KB. */
export function authMd(m: ConnectModel): string {
	const name = mdText(m.name, NAME_MAX) || "A2A agent";
	const peers = m.pairing
		? `- Peers: per-peer bearer token from the RFC 8628 device flow at ${m.base}/oauth/device_authorization\n` +
			`  (metadata: /.well-known/oauth-authorization-server). A person (this agent's owner) approves. Codes last 60 minutes.\n` +
			`- CLI: \`${DEFAULT_CLI} connect ${m.base}\` (stores the token, never prints it).\n`
		: `- Peers: pairing is turned off here. Ask this agent's operator for a per-peer bearer token.\n`;
	const owner = m.mcp ? `- Owner tools (\`/mcp\`, scope \`inbox\`) are for this agent's owner only.\n` : "";
	return `# auth.md: ${name}\n\n${peers}${owner}` +
		`- Never paste tokens in chat. Revoke: the owner runs \`token revoke <label>\`.\n` +
		`Full map of every a2a.exposed credential: ${m.docs}/auth.md\n`;
}

export const markdownHeaders = (): Record<string, string> => ({
	"content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", vary: "accept", "x-content-type-options": "nosniff",
});

/** auth.md is one representation (no content negotiation), so no Vary. CORS * like the other public discovery files. */
export const authMdHeaders = (): Record<string, string> => ({
	"content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", "access-control-allow-origin": "*", "x-content-type-options": "nosniff",
});

export const llmsHeaders = (): Record<string, string> => ({
	"content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff",
});

// ------------------------------------------------------------------ crawlers: robots.txt, sitemap.xml, Link (#348)

/** Default Content-Signal: search and answering with this page are fine; training on it is not. */
export const DEFAULT_CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=no";

/** CONTENT_SIGNAL as one safe line: comma-separated `name=yes|no` pairs, else the default. */
export function contentSignal(v: string | undefined): string {
	const s = (v || "").trim();
	if (!s) return DEFAULT_CONTENT_SIGNAL;
	const parts = s.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
	if (!parts.length || parts.length > 10 || !parts.every((p) => /^[a-z][a-z0-9-]{0,31}\s*=\s*(?:yes|no)$/.test(p))) return DEFAULT_CONTENT_SIGNAL;
	return parts.map((p) => p.replace(/\s*=\s*/, "=")).join(", ");
}

/** ROBOTS_POLICY=disallow asks crawlers to stay away (staging); anything else allows them. */
export const robotsDisallow = (v: string | undefined): boolean => (v || "").trim().toLowerCase() === "disallow";

/** Paths crawlers have no business in: owner API, OAuth and approval pages, MCP, push, relay. */
const ROBOTS_DISALLOW = ["/owner", "/oauth/", "/device", "/mcp", "/push", "/relay/"];

export function robotsTxt(base: string, disallow: boolean, signal: string): string {
	const rules = disallow ? ["Disallow: /"] : ["Allow: /", ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`)];
	return [
		"# A2A agent endpoint served by a2a-exposed. Agents: start at /index.md or /.well-known/agent-card.json",
		"User-agent: *", ...rules,
		`Content-Signal: ${signal}`,
		...(disallow ? [] : [`Sitemap: ${base}/sitemap.xml`]),
	].join("\n") + "\n";
}

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

/** The public pages only; never /device or /owner. No lastmod: the card has no change time to report. */
export function sitemapXml(base: string): string {
	const urls = ["/", "/index.md", "/llms.txt", "/.well-known/agent-card.json"];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
		urls.map((p) => `<url><loc>${xmlEsc(base + p)}</loc></url>\n`).join("") + `</urlset>\n`;
}

/** Link header for GET / (every variant) and /index.md, including the RFC 9727 api-catalog relation. */
export function linkHeader(docs: string): string {
	return [
		`</index.md>; rel="alternate"; type="text/markdown"`,
		`</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
		`</.well-known/agent-card.json>; rel="describedby"; type="application/json"`,
		`</llms.txt>; rel="describedby"; type="text/plain"`,
		`<${docsLinks(docs).connect}>; rel="service-doc"; type="text/markdown"`,
	].join(", ");
}

export const NOINDEX = "noindex, nofollow";

// ------------------------------------------------------------------ Agent Skills discovery index (#349)

export const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** Where the SKILL.md files of a release live: the repository at the release tag, so a self-hosted v0.8.x install
 *  links the v0.8.x skills whose bytes match the digests. */
export const skillsRepoBase = (version: string): string =>
	`https://raw.githubusercontent.com/telegraphic-dev/a2a-exposed/v${encodeURIComponent(version)}/skills`;

/** SKILLS_BASE_URL as an https base with no trailing slash (credentials, query, and fragment rejected), else the
 *  release tag in the repository. Hosted sets it to https://a2a.exposed/.well-known/agent-skills: same bytes. */
export function skillsBase(v: string | undefined, version: string): string {
	const s = (v || "").trim();
	if (s) {
		try {
			const u = new URL(s);
			if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) return (u.origin + u.pathname).replace(/\/+$/, "");
		} catch { /* fall through */ }
	}
	return skillsRepoBase(version);
}

export type SkillEntry = { name: string; description: string; digest: string };

/** GET /.well-known/agent-skills/index.json: the canonical skills by absolute, version-pinned URL. Only the index is
 *  served; the SKILL.md bodies stay at their canonical home. */
export function skillsIndex(skills: readonly SkillEntry[], base: string): { $schema: string; skills: Record<string, string>[] } {
	return { $schema: SKILLS_SCHEMA, skills: skills.map((s) => ({ name: s.name, type: "skill-md", description: s.description, url: `${base}/${s.name}/SKILL.md`, digest: s.digest })) };
}

/** The canonical URL a /.well-known/agent-skills/<name>/SKILL.md request on the agent redirects to, or null. */
export function skillRedirect(path: string, skills: readonly SkillEntry[], base: string): string | null {
	const m = /^\/\.well-known\/agent-skills\/([a-z0-9-]{1,64})\/SKILL\.md$/.exec(path);
	return m && skills.some((s) => s.name === m[1]) ? `${base}/${m[1]}/SKILL.md` : null;
}
