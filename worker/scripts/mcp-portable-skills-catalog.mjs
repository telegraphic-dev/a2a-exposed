#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { SkillCatalog, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { buildSkillsCatalog, DEFAULT_ROOT } from "./mcp-skills-catalog.mjs";

export const PORTABLE_OUTPUT = "worker/src/mcp-portable-skills-catalog.json";
const TOP_FIELDS = ["name", "description", "license", "compatibility", "allowed-tools", "metadata"];
const STRING_METADATA = ["version", "author", "homepage"];
const PLATFORM_METADATA = ["hermes", "openclaw", "required_skills"];
const NAMES = ["a2a-exposed", "a2a-exposed-setup"];

/** Explicit MCP-only edition. Canonical source and all filesystem/plugin packages stay intact. */
export async function portableCatalog(canonical) {
	if (canonical.skills.length !== NAMES.length || NAMES.some((name) => !canonical.skills.some((s) => s.frontmatter.name === name)))
		throw new Error("portable edition requires both reviewed companion skills");
	const files = {};
	for (const skill of canonical.skills) {
		const fm = skill.frontmatter;
		if (Object.keys(fm).some((key) => !TOP_FIELDS.includes(key))) throw new Error("unassigned portable frontmatter field");
		if (!fm.metadata || Object.keys(fm.metadata).some((key) => !STRING_METADATA.includes(key) && !PLATFORM_METADATA.includes(key)))
			throw new Error("unassigned portable metadata field");
		const projected = {};
		for (const key of TOP_FIELDS.filter((k) => k !== "metadata")) if (fm[key] !== undefined) projected[key] = fm[key];
		projected.metadata = {};
		for (const key of STRING_METADATA) {
			if (typeof fm.metadata[key] !== "string") throw new Error(`portable metadata ${key} must be a string`);
			projected.metadata[key] = fm.metadata[key];
		}
		const dependencies = fm.metadata.required_skills;
		if (fm.name === "a2a-exposed" && JSON.stringify(dependencies) !== '["a2a-exposed-setup"]' || fm.name === "a2a-exposed-setup" && dependencies !== undefined)
			throw new Error("unassigned companion dependency");
		for (const resource of skill.resources) {
			const relative = resource.uri.slice("skill://".length).split("/").map(decodeURIComponent).join("/");
			let content = Buffer.from(canonical.resources[resource.uri], "base64");
			if (resource.uri === skill.uri) {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
				const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
				if (!frontmatter) throw new Error("canonical skill has no frontmatter");
				const body = text.slice(frontmatter[0].length);
				if (fm.name === "a2a-exposed" && !body.includes("[a2a-exposed-setup](../a2a-exposed-setup/SKILL.md)"))
					throw new Error("portable operating instructions must preserve companion discovery");
				content = Buffer.from("---\n" + stringify(projected, { lineWidth: 0 }) + "---\n" + body);
			}
			files["portable/" + relative] = content;
		}
	}
	const warnings = [];
	const catalog = await SkillCatalog.load(memorySkillFiles(files), { strict: true, onWarning: (warning) => warnings.push(warning) });
	if (warnings.length) throw new Error("official portable catalog emitted warnings");
	const resources = {};
	for (const skill of catalog.entries) for (const resource of skill.resources) {
		const relative = resource.uri.slice("skill://".length).split("/").map(decodeURIComponent).join("/");
		resources[resource.uri] = Buffer.from(files[relative]).toString("base64");
	}
	return { skills: catalog.entries, resources };
}

export async function buildPortableSkillsCatalog(root = DEFAULT_ROOT) {
	// Fail on files not present in the reviewed repository inventory, including ignored files.
	const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "skills/"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error("portable edition requires a reviewed Git source tree");
	const allowedPaths = new Set(result.stdout.split("\0").filter(Boolean).map((file) => file.slice("skills/".length)));
	if (!allowedPaths.size) throw new Error("portable edition has no reviewed source paths");
	return portableCatalog(await buildSkillsCatalog(root, { allowedPaths }));
}

export async function writePortableSkillsCatalog(root = DEFAULT_ROOT, { check = false } = {}) {
	const output = path.join(root, PORTABLE_OUTPUT);
	const text = JSON.stringify(await buildPortableSkillsCatalog(root), null, 2) + "\n";
	const current = fs.existsSync(output) && fs.readFileSync(output, "utf8") === text;
	if (!check && !current) fs.writeFileSync(output, text);
	return current;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!await writePortableSkillsCatalog(DEFAULT_ROOT, { check: process.argv.includes("--check") }) && process.argv.includes("--check")) {
		console.error("Portable MCP skills catalog is stale; run node worker/scripts/mcp-portable-skills-catalog.mjs");
		process.exitCode = 1;
	}
}
