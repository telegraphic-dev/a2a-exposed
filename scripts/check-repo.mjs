// Small dependency-free checks; TypeScript semantics are checked by tsc in CI.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
if (!["lint", "format"].includes(mode)) {
	console.error("Usage: node scripts/check-repo.mjs <lint|format>");
	process.exit(2);
}
const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (tracked.status !== 0) throw new Error(tracked.stderr || "git ls-files failed");
const files = tracked.stdout.split("\0").filter(Boolean);
let errors = 0;
function fail(file, message) {
	console.error(`${file}: ${message}`);
	errors++;
}
for (const file of files) {
	const bytes = fs.readFileSync(file);
	if (bytes.includes(0)) continue; // Ignore binary assets.
	const text = bytes.toString("utf8");
	if (mode === "format") {
		if (text && !text.endsWith("\n")) fail(file, "missing final newline");
		text.split("\n").forEach((line, i) => {
			if (/\r$/.test(line)) fail(file, `line ${i + 1}: use LF line endings`);
			if (/[\t ]+\r?$/.test(line)) fail(file, `line ${i + 1}: trailing whitespace`);
		});
		continue;
	}
	if (file.endsWith(".json")) {
		try { JSON.parse(text); } catch (error) { fail(file, error.message); }
	}
	if (file.endsWith(".mjs")) {
		const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
		if (result.status !== 0) fail(file, result.stderr || "syntax check failed");
	}
	if (file.endsWith(".py")) {
		const result = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])", file], { input: text, encoding: "utf8" });
		if (result.status !== 0) fail(file, result.stderr || "Python syntax check failed");
	}
	if (/^\.github\/workflows\/.*\.ya?ml$/.test(file)) {
		for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
			const action = match[1];
			if (!action.startsWith("./") && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(action)) {
				fail(file, `pin action to a full commit SHA: ${action}`);
			}
		}
	}
}
if (errors) process.exitCode = 1;
else console.log(`${mode}: checked ${files.length} tracked files`);
