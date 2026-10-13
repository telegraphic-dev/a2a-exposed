// The private dashboard imports this entry and nothing under it. A removed route,
// type, or function fails here, in OSS CI, before a tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONTROL_MIGRATIONS,
	CONTROL_MIGRATIONS_DIR,
	INBOX_MIGRATIONS,
	PERMISSION_DELAYS_MS,
	PERMISSION_TRIES,
	PROVISION_TAG_NAME,
	RUN_WORKER_FIRST,
	WAKE_PRESETS,
	WIZARD_STEPS,
	accountAgentLimit,
	cloudflareHostname,
	configFields,
	configuredFreeAgentLimit,
	createCloudflareAgent,
	createTenant,
	dashboardLinks,
	dataPlaneFromEnv,
	deleteCloudflareInbox,
	deleteTenant,
	deliverOutbox,
	fieldsFromForm,
	flushOutbox,
	hashOwnerToken,
	listCloudflareInboxes,
	listTenants,
	newOwnerToken,
	openWakeSecrets,
	permissionRetryDue,
	pushFromRow,
	readCloudflareInbox,
	readCloudflareInboxById,
	removalItems,
	removalSteps,
	resumeFields,
	rotateOwnerToken,
	routes,
	runInboxStep,
	runRemovalStep,
	saveWakeSettings,
	sealWakeSecrets,
	tenantForAccount,
	tenantNameProblem,
	viewInboxWizard,
	wakeHeaderProblem,
	wakeSettingsOf,
	wakeUrlProblem,
	withOutboxLock,
	type ControlEnv,
	type ControlMigration,
	type CoreRoutes,
	type CreateResult,
	type DataPlane,
	type InboxMigration,
	type InboxRow,
	type InboxWizard,
	type PlaneEnv,
	type ProvisionFields,
	type Sql,
} from "../src/core/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const probe = `
	const core = await import("@a2a-exposed/control-core");
	if (core.RUN_WORKER_FIRST !== true) process.exit(2);
	if (core.routes.tenants !== "/api/v1/tenants" || core.routes.health !== "/health") process.exit(3);
	if (typeof core.createTenant !== "function" || typeof core.runInboxStep !== "function") process.exit(4);
	if (typeof core.runRemovalStep !== "function" || typeof core.cfCall !== "function") process.exit(5);
	if (!Array.isArray(core.CONTROL_MIGRATIONS) || core.CONTROL_MIGRATIONS[0]?.name !== "0001_auth.sql") process.exit(6);
	if (!String(core.CONTROL_MIGRATIONS[0]?.sql).includes("CREATE TABLE")) process.exit(7);
	if (!Array.isArray(core.INBOX_MIGRATIONS) || !core.INBOX_MIGRATIONS[0]?.sql.includes("CREATE TABLE")) process.exit(8);
`;

const health: "/health" = routes.health;
const tenantsPath: "/api/v1/tenants" = routes.tenants;
const workerFirst: true = RUN_WORKER_FIRST;

function acceptsCore(input: {
	env: ControlEnv;
	db: Sql;
	plane: DataPlane;
	planeEnv: PlaneEnv;
	migration: ControlMigration;
	inboxMigration: InboxMigration;
	wizard: InboxWizard;
	fields: ProvisionFields;
	row: InboxRow;
	result: CreateResult;
	routes: CoreRoutes;
}): void {
	void input;
}
void acceptsCore;

test("this file imports only the control-core entry", () => {
	const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/^import\s[^;]*from\s+["']([^"']+)["']/gm)].map((match) => match[1] ?? "");
	assert.deepEqual(specifiers.filter((spec) => !spec.startsWith("node:")), ["../src/core/index.ts"]);
});

test("the entry re-exports tenants, provisioning, routing, env, and migrations", () => {
	const entry = fs.readFileSync(path.join(here, "../src/core/index.ts"), "utf8");
	const specifiers = [...entry.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
	for (const spec of specifiers) {
		const allowed = spec.startsWith("../tenants/")
			|| spec.startsWith("../provision/")
			|| spec === "../routing.ts"
			|| spec === "../env.ts"
			|| spec === "../auth/invites.ts"
			|| spec === "./migrations.ts"
			|| spec === "./routes.ts";
		assert.equal(allowed, true, spec);
	}
	assert.equal(workerFirst, true);
	assert.equal(health, "/health");
	assert.equal(tenantsPath, "/api/v1/tenants");
	assert.deepEqual(routes, { health: "/health", tenants: "/api/v1/tenants" });
	assert.equal(PROVISION_TAG_NAME, "A2A_PROVISION_TAG");
	assert.equal(PERMISSION_TRIES, 4);
	assert.deepEqual(PERMISSION_DELAYS_MS, [2_000, 4_000, 8_000]);
	assert.deepEqual(WIZARD_STEPS, ["grant", "account", "address", "name", "database", "migrations", "upload", "verify"]);
	assert.deepEqual(WAKE_PRESETS, ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent", "hermes", "generic"]);
	assert.equal(CONTROL_MIGRATIONS_DIR, "control/migrations");
	assert.equal(configuredFreeAgentLimit("2"), 2);
	assert.equal(configuredFreeAgentLimit(""), null);
	assert.equal(tenantNameProblem("ab"), "invalid_name");
	assert.equal(tenantNameProblem("admin"), "reserved_name");
	assert.equal(tenantNameProblem("abcd"), "");

	const functions = [
		accountAgentLimit,
		cloudflareHostname,
		configFields,
		createCloudflareAgent,
		createTenant,
		dashboardLinks,
		dataPlaneFromEnv,
		deleteCloudflareInbox,
		deleteTenant,
		deliverOutbox,
		fieldsFromForm,
		flushOutbox,
		hashOwnerToken,
		listCloudflareInboxes,
		listTenants,
		newOwnerToken,
		openWakeSecrets,
		permissionRetryDue,
		pushFromRow,
		readCloudflareInbox,
		readCloudflareInboxById,
		removalItems,
		removalSteps,
		resumeFields,
		rotateOwnerToken,
		runInboxStep,
		runRemovalStep,
		saveWakeSettings,
		sealWakeSecrets,
		tenantForAccount,
		viewInboxWizard,
		wakeHeaderProblem,
		wakeSettingsOf,
		wakeUrlProblem,
		withOutboxLock,
	];
	for (const fn of functions) assert.equal(typeof fn, "function");
});

test("control and inbox migrations match the files on disk", () => {
	const controlDir = path.join(repo, "control/migrations");
	const controlNames = fs.readdirSync(controlDir).filter((name) => name.endsWith(".sql")).sort();
	assert.deepEqual(CONTROL_MIGRATIONS.map((migration) => migration.name), controlNames);
	for (const migration of CONTROL_MIGRATIONS) {
		assert.equal(migration.sql, fs.readFileSync(path.join(controlDir, migration.name), "utf8"));
	}
	const inboxDir = path.join(repo, "worker/migrations");
	const inboxNames = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".sql")).sort();
	assert.deepEqual(INBOX_MIGRATIONS.map((migration) => migration.name), inboxNames);
	for (const migration of INBOX_MIGRATIONS) {
		assert.equal(migration.sql, fs.readFileSync(path.join(inboxDir, migration.name), "utf8"));
	}
});

test("the published package loads the entry and hides deep paths", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
		scripts?: { prepare?: string; prepack?: string };
		exports?: { "."?: { types?: string; default?: string } };
	};
	assert.equal(manifest.scripts?.prepare, "node control/scripts/build-core.mjs");
	assert.equal(manifest.scripts?.prepack, "node control/scripts/build-core.mjs");
	assert.equal(manifest.exports?.["."]?.default, "./dist/index.js");
	assert.equal(manifest.exports?.["."]?.types, "./dist/types/control/src/core/index.d.ts");
	fs.rmSync(path.join(repo, "dist"), { recursive: true, force: true });
	const linked = fs.mkdtempSync(path.join(os.tmpdir(), "control-core-file-"));
	try {
		const fromFile = spawnSync("npm", ["install", "--no-audit", "--no-fund", `file:${repo}`], {
			cwd: linked,
			encoding: "utf8",
		});
		assert.equal(fromFile.status, 0, `${fromFile.stderr}\n${fromFile.stdout}`);
		const loaded = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { cwd: linked, encoding: "utf8" });
		assert.equal(loaded.status, 0, `${loaded.stderr}\n${loaded.stdout}`);
	} finally {
		fs.rmSync(linked, { recursive: true, force: true });
	}
	const packed = spawnSync("npm", ["pack", "--json"], { cwd: repo, encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const info = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
	const filename = info[0]?.filename ?? "";
	const tarball = path.join(repo, filename);
	const listed = new Set((info[0]?.files ?? []).map((file) => file.path));
	assert.equal(listed.has("dist/index.js"), true);
	assert.equal(listed.has("dist/types/control/src/core/index.d.ts"), true);
	assert.equal(listed.has("control/migrations/0001_auth.sql"), true);
	assert.equal(listed.has("control/src/core/index.ts"), false);
	assert.equal(listed.has("control/src/views/account.tsx"), false);
	const dest = fs.mkdtempSync(path.join(os.tmpdir(), "control-core-"));
	try {
		const installed = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
			cwd: dest,
			encoding: "utf8",
		});
		assert.equal(installed.status, 0, installed.stderr);
		const ran = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], { cwd: dest, encoding: "utf8" });
		assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
		const consumer = `
			import { CONTROL_MIGRATIONS, RUN_WORKER_FIRST, createTenant, routes, type ControlEnv } from "@a2a-exposed/control-core";
			const health: "/health" = routes.health;
			const tenantsPath: "/api/v1/tenants" = routes.tenants;
			const workerFirst: true = RUN_WORKER_FIRST;
			const env: ControlEnv = {};
			if (CONTROL_MIGRATIONS[0]?.name !== "0001_auth.sql") throw new Error("migrations");
			void health; void tenantsPath; void workerFirst; void env; void createTenant;
		`;
		fs.writeFileSync(path.join(dest, "consumer.mts"), consumer);
		fs.writeFileSync(path.join(dest, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "es2024",
				lib: ["es2024", "DOM"],
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				types: [],
				skipLibCheck: true,
			},
			files: ["consumer.mts"],
		}));
		const checked = spawnSync(process.execPath, [
			path.join(repo, "control/node_modules/typescript/bin/tsc"),
			"-p",
			path.join(dest, "tsconfig.json"),
			"--pretty",
			"false",
		], { cwd: dest, encoding: "utf8" });
		assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
		const denied = spawnSync(process.execPath, [
			"--input-type=module",
			"--eval",
			'await import("@a2a-exposed/control-core/control/src/views/account.tsx")',
		], { cwd: dest, encoding: "utf8" });
		assert.equal(denied.status === 0, false);
		assert.match(`${denied.stderr}\n${denied.stdout}`, /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by ["']exports["']/);
	} finally {
		fs.rmSync(tarball, { force: true });
		fs.rmSync(dest, { recursive: true, force: true });
		fs.rmSync(path.join(repo, "dist"), { recursive: true, force: true });
	}
});
