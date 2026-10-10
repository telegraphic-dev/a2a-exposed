// Confirms `cf build` emitted static assets, the Worker-first paths, and a small bundle.
// Optional: --expect <text> in the built files, --routes after a build with CONTROL_HOSTNAME set.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, ".cloudflare");

function walk(dir, acc = []) {
	if (!fs.existsSync(dir)) return acc;
	for (const name of fs.readdirSync(dir)) {
		const abs = path.join(dir, name);
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) walk(abs, acc);
		else acc.push(abs);
	}
	return acc;
}

function expectedPaths() {
	const src = fs.readFileSync(path.join(root, "src/routing.ts"), "utf8");
	const match = src.match(/export const RUN_WORKER_FIRST = (\[[\s\S]*?\]);/);
	if (!match) throw new Error("RUN_WORKER_FIRST is missing from src/routing.ts");
	return JSON.parse(match[1].replace(/,(\s*])/g, "$1"));
}

const files = walk(out);
if (!files.length) {
	console.error("check-build: no .cloudflare output. Run npm run build first.");
	process.exit(1);
}

const configs = [];
for (const file of files) {
	if (!file.endsWith(".json")) continue;
	const text = fs.readFileSync(file, "utf8");
	if (!text.includes("runWorkerFirst") && !text.includes("run_worker_first")) continue;
	try {
		configs.push({ file, json: JSON.parse(text) });
	} catch {
		// A JSON file can mention the key inside a string. The worker config parses.
	}
}
if (!configs.length) {
	console.error("check-build: no JSON config with runWorkerFirst under .cloudflare");
	process.exit(1);
}

const want = expectedPaths();
let assetsOk = false;
for (const { file, json } of configs) {
	const assets = json.assets ?? json.worker?.assets;
	const paths = assets?.runWorkerFirst ?? assets?.run_worker_first;
	if (!paths) continue;
	const got = JSON.stringify(paths);
	const expected = JSON.stringify(want);
	if (got !== expected) {
		console.error(`check-build: ${file} runWorkerFirst ${got} != ${expected}`);
		process.exit(1);
	}
	const bound = json.env?.ASSETS?.type === "assets" || assets.binding === "ASSETS";
	if (!bound) {
		console.error(`check-build: ${file} is missing the ASSETS binding`);
		process.exit(1);
	}
	assetsOk = true;
	if (process.argv.includes("--routes")) {
		const domains = json.domains ?? [];
		const triggers = json.triggers ?? [];
		const domain = domains.includes("control.example.com");
		const zone = triggers.some((trigger) => trigger
			&& trigger.type === "fetch"
			&& trigger.pattern === "example.com/*"
			&& trigger.zone === "example.com");
		if (!domain || !zone) {
			console.error("check-build: expected domains and a zone trigger, got " + JSON.stringify({ domains, triggers }));
			process.exit(1);
		}
	}
}
if (!assetsOk) {
	console.error("check-build: runWorkerFirst was not an array on the worker assets config");
	process.exit(1);
}

const scripts = files.filter((file) => /\.(m)?js$/.test(file) && !file.endsWith(".map"));
const largest = scripts.map((file) => ({ file, size: fs.statSync(file).size })).sort((a, b) => b.size - a.size)[0];
const limit = 250_000;
if (!largest || largest.size > limit) {
	console.error(`check-build: worker bundle ${largest ? largest.size : 0} bytes exceeds ${limit}`);
	process.exit(1);
}

const blob = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
if (!blob.includes("sign in / create an agent")) {
	console.error("check-build: built assets are missing the neutral page");
	process.exit(1);
}
const expectFlag = process.argv.indexOf("--expect");
if (expectFlag >= 0) {
	const text = process.argv[expectFlag + 1];
	if (!blob.includes(text)) {
		console.error(`check-build: built output is missing ${text}`);
		process.exit(1);
	}
}
console.log(`check-build: ok (${largest.size} byte bundle, runWorkerFirst ${want.length} paths)`);
