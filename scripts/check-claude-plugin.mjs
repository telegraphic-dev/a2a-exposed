// Validate the installable plugin tree without repository-only contributor context.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const staging = mkdtempSync(join(tmpdir(), "a2a-plugin-check-"));
try {
	for (const entry of [".claude-plugin", "skills", "assets", "LICENSE", "README.md", "plugin.json"]) {
		cpSync(join(root, entry), join(staging, entry), { recursive: true });
	}
	for (const manifest of ["plugin.json", "marketplace.json"]) {
		const result = spawnSync("npx", ["--yes", "@anthropic-ai/claude-code@2.1.296", "plugin", "validate", join(staging, ".claude-plugin", manifest), "--strict"], {
			cwd: root,
			stdio: "inherit",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.exitCode = result.status ?? 1;
			break;
		}
	}
} finally {
	rmSync(staging, { recursive: true, force: true });
}
