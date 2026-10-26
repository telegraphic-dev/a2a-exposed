// Write worker/src/version.ts from cli/package.json. Release preparation runs `npm run version:set`
// before the Worker tests and build, and prepack bundles this tree into the npm package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = process.argv[2] ? path.resolve(process.argv[2]) : path.join(workerRoot, "src", "version.ts");
const version = JSON.parse(fs.readFileSync(path.join(workerRoot, "..", "cli", "package.json"), "utf8")).version;
if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`stamp-version: cli/package.json version ${JSON.stringify(version)} is not a release version`);
	process.exit(1);
}
const body = `/** Inbox build. Keep this equal to \`version\` in cli/package.json. */\nexport const VERSION = ${JSON.stringify(version)};\n`;
if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== body) fs.writeFileSync(dest, body);
