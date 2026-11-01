#!/usr/bin/env node
// One-time release-body migration preview. Deliberately has no write mode.
import fs from "node:fs";

if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
	console.error("Usage: node scripts/seed-release-notes.mjs [--dry-run] (preview only)");
	process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(new URL("./fixtures/release-notes-seed.json", import.meta.url), "utf8"));
const tags = new Set();
for (const { tag, body } of plan) {
	if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) || tags.has(tag) || typeof body !== "string" || !body.trim()) {
		throw new Error("Invalid release seed: expected unique version tags and nonempty bodies");
	}
	tags.add(tag);
}
console.log(JSON.stringify(plan, null, 2));
