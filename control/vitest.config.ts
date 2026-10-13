// Vitest runs inside workerd (Miniflare) via the Workers Vitest plugin.
// These tests need D1 and the compatibility date below. The Cloudflare API is mocked in the test file.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			miniflare: {
				compatibilityDate: "2026-10-06",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["DB"],
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
				},
			},
		})),
	],
	test: {
		include: ["test/workers/**/*.test.ts"],
		setupFiles: ["test/workers/setup.ts"],
		// The Workers runtime cannot read Vitest's on-disk module cache.
		fsModuleCache: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
