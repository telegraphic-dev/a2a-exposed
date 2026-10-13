#!/usr/bin/env node
// Fail when plugin version, description, or keywords drift, when a skill
// description still carries the hosted-inbox sentence, or when a copied skill
// links at docs/ with a relative path. Nested Hermes and OpenClaw metadata is
// checked by scripts/check-skill-metadata.py.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const fail = (msg) => {
	console.error(`check-skill-plugin: ${msg}`);
	process.exitCode = 1;
};

const cliVersion = json("cli/package.json").version;
const plugin = json("plugin.json");
const manifests = [
	"plugin.json",
	".claude-plugin/plugin.json",
	".cursor-plugin/plugin.json",
	".grok-plugin/plugin.json",
];

if (json("package.json").version !== cliVersion) fail(`package.json version ${json("package.json").version} != cli/package.json ${cliVersion}`);

for (const rel of manifests) {
	const doc = json(rel);
	if (doc.version !== cliVersion) fail(`${rel} version ${doc.version} != ${cliVersion}`);
	if (doc.description !== plugin.description) fail(`${rel} description differs from plugin.json`);
	if (JSON.stringify(doc.keywords) !== JSON.stringify(plugin.keywords)) fail(`${rel} keywords differ from plugin.json`);
}

const market = json(".claude-plugin/marketplace.json");
const entry = (market.plugins || [])[0] || {};
if (entry.version !== cliVersion) fail(`marketplace plugin version ${entry.version} != ${cliVersion}`);
if (entry.description !== plugin.description) fail("marketplace plugin description differs from plugin.json");

const logo = plugin.extensions?.["com.openai"]?.onboardingSkill;
if (logo !== "./skills/a2a-exposed-setup/SKILL.md") fail("plugin.json extensions.com.openai.onboardingSkill must point at the setup skill");
if (!fs.existsSync(path.join(root, logo))) fail(`onboarding skill missing: ${logo}`);

const cursor = json(".cursor-plugin/plugin.json");
if (cursor.logo !== "assets/logo.svg") fail("Cursor manifest logo must be assets/logo.svg");
if (!fs.existsSync(path.join(root, cursor.logo))) fail(`Cursor logo missing: ${cursor.logo}`);
if (cursor.skills !== "./skills/") fail('Cursor manifest skills must be "./skills/"');

function frontmatter(text, rel) {
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	if (!m) fail(`${rel} has no frontmatter`);
	return m ? m[1] : "";
}

function field(fm, key) {
	const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

function versionOf(fm, rel) {
	const m = fm.match(/^\s*version:\s*"?([^"\n]+)"?\s*$/m);
	if (!m) fail(`${rel} metadata.version is missing`);
	return m ? m[1].trim() : "";
}

const hosted = /Ask your human to set it up on https:\/\/a2a\.exposed/;
const untestedNames = /\b(Codex|Cursor|Grok Build|n8n|Zapier|Make)\b/;
const skills = ["skills/a2a-exposed/SKILL.md", "skills/a2a-exposed-setup/SKILL.md"];
for (const rel of skills) {
	const text = read(rel);
	const fm = frontmatter(text, rel);
	const description = field(fm, "description");
	if (!description) fail(`${rel} description is empty`);
	if (hosted.test(description)) fail(`${rel} description still carries the hosted-inbox sentence`);
	if (versionOf(fm, rel) !== cliVersion) fail(`${rel} metadata.version != ${cliVersion}`);
	const body = text.replace(/^---\n[\s\S]*?\n---/, "");
	if (rel.endsWith("a2a-exposed-setup/SKILL.md")) {
		if (untestedNames.test(description)) fail("setup description must not name untested clients");
		if (!body.includes("https://a2a.exposed")) fail("setup skill body must name the hosted inbox");
		if (!body.includes("https://a2a.exposed/pricing")) fail("setup skill body must link pricing");
		if (!body.includes("1042")) fail("setup skill body must name Cloudflare error 1042");
		if (!hosted.test(body)) fail("setup skill body must keep the hosted fallback sentence");
		if (!/open to everyone/.test(body)) fail("setup skill body must say the hosted inbox is open to everyone");
	}
}

const dayDesc = field(frontmatter(read("skills/a2a-exposed/SKILL.md"), "skills/a2a-exposed/SKILL.md"), "description");
const setupDesc = field(frontmatter(read("skills/a2a-exposed-setup/SKILL.md"), "skills/a2a-exposed-setup/SKILL.md"), "description");
if (dayDesc === setupDesc) fail("skill descriptions must differ");
if (!/wake|inbox|reply|pair/i.test(dayDesc)) fail("day-to-day description needs its operate triggers");
if (!/deploy|façade|facade/i.test(setupDesc)) fail("setup description needs its deploy triggers");

function walk(dir) {
	const out = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) out.push(...walk(p));
		else if (ent.name.endsWith(".md")) out.push(p);
	}
	return out;
}
for (const file of walk(path.join(root, "skills"))) {
	const rel = path.relative(root, file);
	if (/\]\(\.\.\/(?:\.\.\/)*docs\//.test(read(rel))) fail(`${rel} links to docs/ with a relative path`);
}
for (const rel of ["README.md", "docs/getting-started.md"]) {
	if (/free during beta/i.test(read(rel))) fail(`${rel} must not put plan details in the repo`);
	if (!read(rel).includes("https://a2a.exposed/pricing")) fail(`${rel} must link pricing`);
	if (!read(rel).includes("open to everyone")) fail(`${rel} must say the hosted inbox is open to everyone`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`check-skill-plugin: version ${cliVersion} matches across manifests and skills`);
