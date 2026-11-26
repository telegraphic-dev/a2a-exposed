#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
import { SkillSchema, SKILL_LIMITS } from "@modelcontextprotocol/core/ext/skills";

export const DEFAULT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const OUTPUT = "worker/src/mcp-skills-catalog.json";

// Canonical platform metadata is not portable Agent Skills format. Keep it
// intact for source inventory and isolated compatibility tests; product runtime
// serves the separately generated portable edition through strict SDK helpers.
export async function buildSkillsCatalog(root = DEFAULT_ROOT, { allowedPaths } = {}) {
	const source = path.join(root, "skills");
	if (fs.lstatSync(source).isSymbolicLink()) throw new Error("skills must be a real directory");
	const files = nodeSkillFiles(source);
	const bytes = new Map();
	let aggregateBytes = 0;
	async function walk(dir) {
		for (const entry of (await files.list(dir)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			const relative = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.kind === "directory") await walk(relative);
			else if (entry.kind === "file") {
				if (allowedPaths && !allowedPaths.has(relative)) throw new Error(`unreviewed skill file: ${relative}`);
				const size = fs.lstatSync(path.join(source, relative)).size;
				if (bytes.size >= 1024 || size > SKILL_LIMITS.bytes || aggregateBytes + size > 2 * SKILL_LIMITS.bytes)
					throw new Error("aggregate skills budget exceeded");
				const content = Buffer.from(await files.read(relative));
				aggregateBytes += content.length;
				if (aggregateBytes > 2 * SKILL_LIMITS.bytes) throw new Error("aggregate skills budget exceeded");
				bytes.set(relative, content);
			}
			else throw new Error(`unsupported file or symlink: ${relative}`);
		}
	}
	await walk("");
	const resources = {};
	const skills = [];
	const uriOf = (relative) => "skill://" + relative.split("/").map(encodeURIComponent).join("/");
	for (const [relative, raw] of bytes) {
		if (!relative.endsWith("/SKILL.md")) continue;
		const folder = relative.slice(0, -"/SKILL.md".length);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (!match) throw new Error(`${relative}: missing frontmatter`);
		const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
		if (doc.errors.length || doc.warnings.length) throw new Error(`${relative}: invalid YAML`);
		const frontmatter = doc.toJS({ maxAliasCount: 0 });
		function jsonValue(value) {
			if (value === null || typeof value === "string" || typeof value === "boolean") return;
			if (typeof value === "number" && Number.isFinite(value)) return;
			if (Array.isArray(value)) { value.forEach(jsonValue); return; }
			if (value && Object.getPrototypeOf(value) === Object.prototype) {
				for (const [key, child] of Object.entries(value)) {
					if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`${relative}: unsafe YAML key`);
					jsonValue(child);
				}
				return;
			}
			throw new Error(`${relative}: frontmatter must be JSON-compatible`);
		}
		jsonValue(frontmatter);
		if (!frontmatter || typeof frontmatter.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name) ||
			frontmatter.name.length > 64 || frontmatter.name !== folder.split("/").at(-1) ||
			typeof frontmatter.description !== "string" || !frontmatter.description.trim() || [...frontmatter.description].length > 1024)
			throw new Error(`${relative}: invalid skill name or description`);
		const manifest = [];
		let total = 0;
		for (const [file, content] of bytes) {
			if (!file.startsWith(folder + "/")) continue;
			total += content.length;
			if (manifest.length >= SKILL_LIMITS.files || total > SKILL_LIMITS.bytes) throw new Error(`${relative}: skill exceeds portable limits`);
			const uri = uriOf(file);
			manifest.push({ uri, size: content.length, digest: "sha256:" + crypto.createHash("sha256").update(content).digest("hex") });
			resources[uri] = content.toString("base64");
		}
		skills.push(SkillSchema.parse({ uri: uriOf(relative), frontmatter, resources: manifest }));
	}
	return { skills: skills.sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0), resources };
}

export async function writeSkillsCatalog(root = DEFAULT_ROOT, { check = false } = {}) {
	const output = path.join(root, OUTPUT);
	const text = JSON.stringify(await buildSkillsCatalog(root), null, 2) + "\n";
	const current = fs.existsSync(output) && fs.readFileSync(output, "utf8") === text;
	if (!check && !current) fs.writeFileSync(output, text);
	return current;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!await writeSkillsCatalog(DEFAULT_ROOT, { check: process.argv.includes("--check") }) && process.argv.includes("--check")) {
		console.error("MCP skills catalog is stale; run node worker/scripts/mcp-skills-catalog.mjs");
		process.exitCode = 1;
	}
}
