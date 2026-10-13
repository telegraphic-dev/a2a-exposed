// Compile `@a2a-exposed/control-core` for npm. `prepack` runs this.
// Output is dist/index.js plus the declaration files the entry's types reach.
// The control Worker does not import this output.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const controlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(controlRoot, "..");
const dist = path.join(repoRoot, "dist");
const typesRoot = path.join(dist, "types");
const entryDts = path.join(typesRoot, "control/src/core/index.d.ts");

function fail(message) {
	console.error(`build-core: ${message}`);
	process.exit(1);
}

function ensureControlDeps() {
	const esbuildPkg = path.join(controlRoot, "node_modules/esbuild/package.json");
	const tscBin = path.join(controlRoot, "node_modules/typescript/bin/tsc");
	if (fs.existsSync(esbuildPkg) && fs.existsSync(tscBin)) return;
	console.error("build-core: installing control dependencies");
	const installed = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
		cwd: controlRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (installed.status !== 0 || !fs.existsSync(esbuildPkg) || !fs.existsSync(tscBin)) {
		fail("control dependencies are missing. From control/, run npm ci.");
	}
}

ensureControlDeps();

const require = createRequire(path.join(controlRoot, "package.json"));
const esbuild = require("esbuild");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const sqlRaw = {
	name: "sql-raw",
	setup(build) {
		build.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
			namespace: "sql-raw",
		}));
		build.onLoad({ filter: /\.sql$/, namespace: "sql-raw" }, (args) => ({
			contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))};`,
			loader: "js",
		}));
	},
};

const built = await esbuild.build({
	absWorkingDir: controlRoot,
	entryPoints: ["src/core/index.ts"],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2024",
	outfile: path.join(dist, "index.js"),
	plugins: [sqlRaw],
	legalComments: "none",
	logLevel: "warning",
	metafile: true,
	banner: { js: "/* @a2a-exposed/control-core */" },
});

const pulled = Object.keys(built.metafile.inputs).filter((file) =>
	file.includes("node_modules") || file.includes("/views/") || file.includes("/brand/") || file.includes("better-auth")
);
if (pulled.length > 0) fail(`bundle inputs are outside control-core:\n${pulled.join("\n")}`);

const js = fs.readFileSync(path.join(dist, "index.js"), "utf8");
if (js.includes("better-auth") || js.includes("hono/jsx") || js.includes('from"hono"') || js.includes('from "hono"')) {
	fail("dist/index.js still mentions better-auth or hono");
}

const tsc = path.join(controlRoot, "node_modules/typescript/bin/tsc");
const emitted = spawnSync(process.execPath, [
	tsc,
	"-p",
	path.join(controlRoot, "tsconfig.core.json"),
	"--noCheck",
	"--pretty",
	"false",
], { cwd: controlRoot, encoding: "utf8" });
if (emitted.status !== 0) {
	if (emitted.stdout) console.error(emitted.stdout);
	if (emitted.stderr) console.error(emitted.stderr);
	fail("tsc declaration emit failed");
}

function specifiers(text) {
	const found = [];
	for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(match[1] ?? "");
	for (const match of text.matchAll(/import\(["']([^"']+)["']\)/g)) found.push(match[1] ?? "");
	return found;
}

function resolveDts(fromFile, spec) {
	const base = path.resolve(path.dirname(fromFile), spec);
	const candidates = [base, `${base}.d.ts`, base.replace(/\.tsx?$/, ".d.ts"), base.replace(/\.js$/, ".d.ts")];
	return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? "";
}

function rewriteTsSpecifiers(text) {
	return text.replaceAll(/(["'])(\.{1,2}\/[^"']+?)\.tsx?\1/g, (_match, quote, spec) => `${quote}${spec}.js${quote}`);
}

if (!fs.existsSync(entryDts)) fail("declaration entry was not emitted");

const kept = new Set();
const pending = [entryDts];
while (pending.length > 0) {
	const file = pending.pop();
	if (!file || kept.has(file)) continue;
	kept.add(file);
	const text = fs.readFileSync(file, "utf8");
	for (const spec of specifiers(text)) {
		if (!spec.startsWith(".")) fail(`${path.relative(repoRoot, file)} imports ${spec}`);
		const resolved = resolveDts(file, spec);
		if (!resolved) fail(`${path.relative(repoRoot, file)} imports missing ${spec}`);
		pending.push(resolved);
	}
}

for (const file of kept) {
	const next = rewriteTsSpecifiers(fs.readFileSync(file, "utf8"));
	if (/(?:from\s+|import\()["'][^"']+\.tsx?["']/.test(next)) fail(`${path.relative(repoRoot, file)} still imports a .ts path`);
	if (next.includes("better-auth") || next.includes("@brand") || next.includes("hono/jsx")) {
		fail(`${path.relative(repoRoot, file)} still names better-auth, hono, or @brand`);
	}
	fs.writeFileSync(file, next);
}

function walkDts(dir, out) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) walkDts(full, out);
		else if (name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

for (const file of walkDts(typesRoot, [])) {
	if (!kept.has(file)) fs.rmSync(file);
}

function removeEmpty(dir) {
	if (!fs.existsSync(dir)) return;
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) removeEmpty(full);
	}
	if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
removeEmpty(typesRoot);

const core = await import(pathToFileURL(path.join(dist, "index.js")).href);
if (core.RUN_WORKER_FIRST !== true || core.routes?.health !== "/health" || core.routes?.tenants !== "/api/v1/tenants") {
	fail("dist/index.js did not export routes and RUN_WORKER_FIRST");
}
if (typeof core.createTenant !== "function" || typeof core.cfCall !== "function" || typeof core.runInboxStep !== "function") {
	fail("dist/index.js did not export the provisioning functions");
}
if (!Array.isArray(core.CONTROL_MIGRATIONS) || !core.CONTROL_MIGRATIONS[0]?.sql?.includes("CREATE TABLE")) {
	fail("dist/index.js did not inline the control migrations");
}
if (!Array.isArray(core.INBOX_MIGRATIONS) || !core.INBOX_MIGRATIONS[0]?.sql?.includes("CREATE TABLE")) {
	fail("dist/index.js did not inline the inbox migrations");
}

console.error(`build-core: dist/index.js (${js.length} bytes), ${kept.size} declaration files`);
