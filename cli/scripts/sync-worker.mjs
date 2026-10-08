// prepack: bundle the Worker template (../worker) into the npm package as ./worker
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "..", "worker");
const dst = path.join(root, "worker");
if (!fs.existsSync(path.join(src, "cloudflare.config.ts"))) {
	if (fs.existsSync(path.join(dst, "cloudflare.config.ts"))) process.exit(0); // already bundled
	console.error("sync-worker: ../worker not found");
	process.exit(1);
}
const skip = new Set(["node_modules", ".cloudflare", ".wrangler", "deploy.env", "package-lock.json"]);
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, filter: (p) => !skip.has(path.basename(p)) && !/^\.(dev\.vars|env)/.test(path.basename(p)) });
console.error(`sync-worker: bundled ${path.relative(root, src)} -> worker/`);
