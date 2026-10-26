#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2];
// SemVer 2.0.0: numeric identifiers cannot have leading zeroes.
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${numeric}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
if (process.argv.length !== 3 || (!semver.test(version) || version !== version.trim())) {
	console.error("Usage: npm run version:set -- <x.y.z> (valid SemVer required)");
	process.exit(1);
}

// Prepare all changes before writing; replace only version values to retain formatting.
const changes = new Map();
function update(rel, transform) {
	const file = path.join(root, rel);
	const text = fs.readFileSync(file, "utf8");
	changes.set(file, transform(text));
}
function replace(text, pattern, rel) {
	if (!pattern.test(text)) throw new Error(`${rel}: version field missing`);
	return text.replace(pattern, `$1${version}$2`);
}
const topVersion = /^(\s*"version"\s*:\s*")[^"]*(")/m;
for (const dir of ["", "cli", "worker", "control"]) {
	const rel = path.join(dir, "package.json");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
	if (Object.hasOwn(pkg, "version")) update(rel, (text) => replace(text, topVersion, rel));
	const lock = path.join(dir, "package-lock.json");
	if (!fs.existsSync(path.join(root, lock))) continue;
	update(lock, (text) => {
		const doc = JSON.parse(text);
		if (Object.hasOwn(doc, "version")) text = replace(text, topVersion, lock);
		if (Object.hasOwn(doc.packages?.[""] ?? {}, "version")) {
			text = replace(text, /(""\s*:\s*\{[^{}]*?"version"\s*:\s*")[^"]*(")/, lock);
		}
		return text;
	});
}
for (const rel of ["plugin.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json"]) {
	update(rel, (text) => replace(text, topVersion, rel));
}
for (const skill of fs.readdirSync(path.join(root, "skills"))) {
	const rel = `skills/${skill}/SKILL.md`;
	if (!fs.existsSync(path.join(root, rel))) continue;
	update(rel, (text) => replace(text, /(^---\r?\n[\s\S]*?^metadata:\r?\n(?:(?!^\S)[\s\S])*?^ +version: *["']?)[^\s"']+(["']?)/m, rel));
}
update("worker/src/version.ts", (text) => replace(text, /(export const VERSION = ")[^"]*(")/, "worker/src/version.ts"));
for (const [file, text] of changes) fs.writeFileSync(file, text);
console.log(`Release version set to ${version}`);
