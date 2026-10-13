#!/usr/bin/env node
// Fail when plugin version, description, or keywords drift, when skill metadata
// is nested, or when a skill description still carries the hosted-inbox sentence.
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

function flatMetadata(fm, rel) {
	const lines = fm.split("\n");
	const start = lines.findIndex((l) => l === "metadata:");
	if (start < 0) {
		fail(`${rel} has no metadata`);
		return {};
	}
	const map = {};
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		if (!line.startsWith("  ")) break;
		if (line.startsWith("   ") || line.startsWith("\t")) {
			fail(`${rel} metadata is nested: ${line.trim()}`);
			continue;
		}
		const m = line.match(/^  ([^:]+):\s*(.*)$/);
		if (!m) {
			fail(`${rel} metadata line is not a string: ${line}`);
			continue;
		}
		let value = m[2].trim();
		if (/^[>|[{]/.test(value)) fail(`${rel} metadata.${m[1]} is not a single string`);
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		map[m[1].trim()] = value;
	}
	return map;
}

const hosted = /Ask your human to set it up on https:\/\/a2a\.exposed/;
const skills = ["skills/a2a-exposed/SKILL.md", "skills/a2a-exposed-setup/SKILL.md"];
const metas = {};
for (const rel of skills) {
	const text = read(rel);
	const fm = frontmatter(text, rel);
	const description = field(fm, "description");
	if (!description) fail(`${rel} description is empty`);
	if (hosted.test(description)) fail(`${rel} description still carries the hosted-inbox sentence`);
	const meta = flatMetadata(fm, rel);
	metas[rel] = meta;
	if (meta.version !== cliVersion) fail(`${rel} metadata.version ${meta.version} != ${cliVersion}`);
	const body = text.replace(/^---\n[\s\S]*?\n---/, "");
	if (rel.endsWith("a2a-exposed-setup/SKILL.md")) {
		if (!body.includes("https://a2a.exposed")) fail("setup skill body must name the hosted inbox");
		if (!body.includes("1042")) fail("setup skill body must name Cloudflare error 1042");
		if (!hosted.test(body)) fail("setup skill body must keep the hosted fallback sentence");
	}
}

const day = metas["skills/a2a-exposed/SKILL.md"]["hermes.related_skills"] || "";
const setup = metas["skills/a2a-exposed-setup/SKILL.md"]["hermes.related_skills"] || "";
const parts = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
if (!parts(day).includes("a2a-exposed-setup")) fail("a2a-exposed hermes.related_skills must include a2a-exposed-setup");
if (!parts(setup).includes("a2a-exposed")) fail("setup hermes.related_skills must include a2a-exposed");
if (!parts(day).includes("cloudflare") || !parts(setup).includes("cloudflare")) fail("both skills must list cloudflare in hermes.related_skills");
if (!parts(setup).includes("mise")) fail("setup hermes.related_skills must include mise");

const dayDesc = field(frontmatter(read("skills/a2a-exposed/SKILL.md"), "skills/a2a-exposed/SKILL.md"), "description");
const setupDesc = field(frontmatter(read("skills/a2a-exposed-setup/SKILL.md"), "skills/a2a-exposed-setup/SKILL.md"), "description");
if (dayDesc === setupDesc) fail("skill descriptions must differ");
if (!/wake|inbox|reply|pair/i.test(dayDesc)) fail("day-to-day description needs its operate triggers");
if (!/deploy|façade|facade/i.test(setupDesc)) fail("setup description needs its deploy triggers");
if (!/untested/i.test(setupDesc)) fail("setup description must mark untested platforms");

if (process.exitCode) process.exit(process.exitCode);
console.log(`check-skill-plugin: version ${cliVersion} matches across manifests and skills`);
