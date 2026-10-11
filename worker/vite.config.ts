import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { applyWorkerTheme } from "./theme-build.mjs";

export default defineConfig({
	plugins: [
		{
			name: "inbox-theme",
			enforce: "pre",
			transform(_code, id) {
				const next = applyWorkerTheme(id, process.env.WORKER_THEME);
				return next ? { code: next, map: null } : null;
			},
		},
		cloudflare(),
	],
});
