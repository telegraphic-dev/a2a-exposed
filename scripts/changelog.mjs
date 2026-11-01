import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function readFragments(root) {
	const dir = path.join(root, "changelog.d");
	return fs.readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md").sort().map((name) => {
		const file = path.join(dir, name);
		if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular fragment: ${name}`);
		const text = fs.readFileSync(file, "utf8").trim();
		if (!text || /^#{1,2} /m.test(text)) throw new Error(`Fragment must contain entries without release headings: ${name}`);
		return { file, text };
	});
}

export function renderChangelog(changelog, fragments, heading = "Unreleased") {
	const firstRelease = changelog.search(/^## /m);
	if (firstRelease < 0) throw new Error("Changelog has no release heading");
	let history = changelog.slice(firstRelease);
	if (history.startsWith("## Unreleased\n")) {
		const next = history.indexOf("\n## ");
		const pending = history.slice("## Unreleased\n".length, next < 0 ? undefined : next).trim();
		if (pending) throw new Error("Move Unreleased entries to changelog.d first");
		history = next < 0 ? "" : history.slice(next + 1);
	}
	const entries = fragments.map(({ text }) => text).join("\n");
	return changelog.slice(0, firstRelease) + (entries ? `## ${heading}\n\n${entries}\n\n` : "") + history;
}

// Plan before version:set writes any release files. Repeated preparation is a no-op.
export function planRelease(root, version, date = new Date().toISOString().slice(0, 10)) {
	const file = path.join(root, "CHANGELOG.md");
	const changelog = fs.readFileSync(file, "utf8");
	const fragments = readFragments(root);
	if (changelog.split("\n").some((line) => line.startsWith(`## ${version} - `))) {
		if (fragments.length) throw new Error(`Release ${version} already exists; fragments remain unreleased`);
		return { file, text: changelog, fragments };
	}
	if (!fragments.length) throw new Error("Release requires a changelog.d fragment");
	return { file, text: renderChangelog(changelog, fragments, `${version} - ${date}`), fragments };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const root = path.resolve(import.meta.dirname, "..");
	if (process.argv.length !== 2) throw new Error("Usage: npm run changelog:preview");
	process.stdout.write(renderChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), readFragments(root)));
}
