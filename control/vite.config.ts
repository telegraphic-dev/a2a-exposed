import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";
import { defineConfig } from "vite";

const root = path.dirname(new URL(import.meta.url).pathname);
const brand = process.env.CONTROL_BRAND_DIR
	? path.resolve(process.env.CONTROL_BRAND_DIR)
	: path.join(root, "brand");
const publicDir = process.env.CONTROL_PUBLIC_DIR
	? path.resolve(process.env.CONTROL_PUBLIC_DIR)
	: path.join(root, "public");

export default defineConfig({
	plugins: [cloudflare()],
	publicDir,
	resolve: {
		alias: { "@brand": brand },
	},
	// Brand files may live outside this package (CONTROL_BRAND_DIR). Compile every TSX file as
	// Hono JSX so an overlay does not fall back to React's runtime.
	oxc: {
		jsx: {
			runtime: "automatic",
			importSource: "hono/jsx",
		},
	},
});
