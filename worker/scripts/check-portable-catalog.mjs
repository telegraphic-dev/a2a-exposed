// Build-time verification also works in a packaged standalone Worker, without
// Git or canonical source files. It never regenerates files or makes requests.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export function checkPortableCatalog(worker = fileURLToPath(new URL("../", import.meta.url))) {
	const text = fs.readFileSync(path.join(worker, "src/version.ts"), "utf8");
	const version = /export const VERSION = "([^"]+)"/.exec(text)?.[1];
	const catalog = JSON.parse(fs.readFileSync(path.join(worker, "src/mcp-portable-skills-catalog.json"), "utf8"));
	if (!version || catalog.skills.length !== 2) throw new Error("portable skills catalog is incomplete");
	const names = new Set();
	const listed = new Set();
	for (const skill of catalog.skills) {
		const name = skill.frontmatter.name;
		if (!["a2a-exposed", "a2a-exposed-setup"].includes(name) || names.has(name) || skill.uri !== `skill://portable/${name}/SKILL.md` || skill.frontmatter.metadata.version !== version)
			throw new Error("portable skills catalog version or identity mismatch; regenerate before build");
		names.add(name);
		for (const file of skill.resources) {
			if (!file.uri.startsWith(`skill://portable/${name}/`) || !Object.hasOwn(catalog.resources, file.uri)) throw new Error("invalid portable resource manifest");
			const bytes = Buffer.from(catalog.resources[file.uri], "base64");
			if (file.size !== bytes.length || file.digest !== "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex")) throw new Error("portable resource integrity mismatch");
			listed.add(file.uri);
		}
		if (!listed.has(skill.uri)) throw new Error("portable skill entry is missing its file");
	}
	if (Object.keys(catalog.resources).some((uri) => !listed.has(uri))) throw new Error("unlisted portable resource");
	return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkPortableCatalog();
