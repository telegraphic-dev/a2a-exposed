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
	if (specifier.endsWith(".tsx")) {
		const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : root;
		return { url: pathToFileURL(path.resolve(parent, specifier)).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
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
