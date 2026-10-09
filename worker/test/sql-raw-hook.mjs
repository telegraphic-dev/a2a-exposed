// Resolve `../migrations/0001_init.sql?raw` to the file text as a default export.
export async function resolve(specifier, context, nextResolve) {
	if (typeof specifier === "string" && specifier.includes(".sql?raw")) {
		const resolved = await nextResolve(specifier.replace(/\?raw$/, ""), context);
		const url = new URL(resolved.url);
		url.searchParams.set("raw", "1");
		return { url: url.href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	const u = new URL(url);
	if (u.searchParams.get("raw") === "1" && u.pathname.endsWith(".sql")) {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		u.search = "";
		const text = readFileSync(fileURLToPath(u), "utf8");
		return { format: "module", source: `export default ${JSON.stringify(text)};\n`, shortCircuit: true };
	}
	return nextLoad(url, context);
}
