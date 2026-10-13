// `node --test` cannot import `*.sql?raw`, and this package's Node may still need
// TypeScript stripped. esbuild does both. There is no JSX in this package.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith(".sql?raw")) {
		const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : root;
		const file = path.resolve(parent, specifier.slice(0, -"?raw".length));
		return { url: `${pathToFileURL(file).href}?raw`, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.includes(".sql?raw")) {
		const file = fileURLToPath(url.slice(0, url.indexOf(".sql?raw") + ".sql".length));
		const source = fs.readFileSync(file, "utf8");
		return { format: "module", source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
	}
	if (url.endsWith(".ts")) {
		const source = fs.readFileSync(fileURLToPath(url), "utf8");
		const result = esbuild.transformSync(source, {
			loader: "ts",
			format: "esm",
			sourcefile: fileURLToPath(url),
		});
		return { format: "module", source: result.code, shortCircuit: true };
	}
	return nextLoad(url, context);
}
