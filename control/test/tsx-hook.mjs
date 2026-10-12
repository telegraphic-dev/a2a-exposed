import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function brandDir() {
	return process.env.CONTROL_BRAND_DIR
		? path.resolve(process.env.CONTROL_BRAND_DIR)
		: path.join(root, "brand");
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith("@brand/")) {
		const file = path.join(brandDir(), specifier.slice("@brand/".length));
		return { url: pathToFileURL(file).href, shortCircuit: true };
	}
	if (specifier.endsWith(".tsx") || specifier.endsWith(".sql?raw")) {
		const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : root;
		const file = specifier.endsWith(".sql?raw") ? specifier.slice(0, -"?raw".length) : specifier;
		const url = pathToFileURL(path.resolve(parent, file)).href;
		return { url: specifier.endsWith(".sql?raw") ? `${url}?raw` : url, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.includes(".sql?raw")) {
		const file = fileURLToPath(url.slice(0, url.indexOf(".sql?raw") + ".sql".length));
		const source = fs.readFileSync(file, "utf8");
		return { format: "module", source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
	}
	if (url.endsWith(".ts") || url.endsWith(".tsx")) {
		const source = fs.readFileSync(fileURLToPath(url), "utf8");
		const result = esbuild.transformSync(source, {
			loader: url.endsWith(".tsx") ? "tsx" : "ts",
			format: "esm",
			jsx: "automatic",
			jsxImportSource: "hono/jsx",
			sourcefile: fileURLToPath(url),
		});
		return { format: "module", source: result.code, shortCircuit: true };
	}
	return nextLoad(url, context);
}
