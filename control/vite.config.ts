import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";
import { defineConfig } from "vite";

const root = path.dirname(new URL(import.meta.url).pathname);
const publicDir = process.env.CONTROL_PUBLIC_DIR
	? path.resolve(process.env.CONTROL_PUBLIC_DIR)
	: path.join(root, "public");

export default defineConfig({
	plugins: [cloudflare()],
	publicDir,
});
