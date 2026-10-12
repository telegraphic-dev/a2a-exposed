// Creates an inbox in the user's Cloudflare account from the saved OAuth grant.
// The access token is used for that request and is not stored. The owner token is
// uploaded as a Worker secret and only its SHA-256 hash is kept here.

import { inboxCanProvision, parseSetupChoice, parseSetupHost, type SetupHost } from "../auth/cloudflare-setup.ts";
import { readCloudflareGrant, refreshCloudflareGrant } from "../auth/cloudflare-grant.ts";
import type { Sql } from "../auth/invites.ts";
import { newOwnerToken } from "../tenants/create.ts";
import {
	attachHostname,
	createD1,
	d1Query,
	findD1,
	listAccounts,
	listZones,
	registerWorkersDevSubdomain,
	setWorkersDevEnabled,
	inboxScriptOwnership,
	uploadWorker,
	workersDevSubdomain,
	type CfAccount,
	type CfFailure,
	type CfZone,
} from "./cloudflare-api.ts";
import { HOST_RE, LABEL_RE, normalizeHostname, workerNameFromHostname, zoneForHostname } from "./names.ts";
import { sqlStatements } from "./statements.ts";

/** Keep in step with worker/cloudflare.config.ts compatibilityDate. */
export const INBOX_COMPATIBILITY_DATE = "2026-10-06";

/** One file from worker/migrations, applied in order. */
export interface InboxMigration {
	name: string;
	sql: string;
}

const WORKING_MS = 2 * 60 * 1000;
const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

export interface ProvisionFields {
	name: string;
	hostname: string;
	subdomain: string;
	account: string;
}

export interface InboxRow {
	userId: string;
	cf_account_id: string;
	worker_name: string;
	d1_name: string;
	d1_id: string | null;
	public_url: string | null;
	owner_token_hash: string | null;
	host: string;
	hostname: string | null;
	status: string;
	created_at: string;
	updated_at: string;
}

export type ProvisionError =
	| "name"
	| "hostname"
	| "subdomain"
	| "need_subdomain"
	| "account"
	| "zone"
	| "taken"
	| "busy"
	| "invalid_grant"
	| "failed"
	| "forbidden"
	| "script"
	| "partial"
	| "no_grant"
	| "blocked";

export type ProvisionOutcome =
	| { ok: true; publicUrl: string; ownerToken: string | null; facade: boolean }
	| { ok: false; error: ProvisionError; accounts?: CfAccount[]; zones?: { name: string }[] };

export async function hashOwnerToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readCloudflareInbox(db: Sql, userId: string): Promise<InboxRow | null> {
	if (!userId) return null;
	return db.prepare(
		`SELECT "userId" AS userId, cf_account_id, worker_name, d1_name, d1_id, public_url, owner_token_hash, host, hostname, status, created_at, updated_at
		 FROM cloudflare_inbox WHERE "userId" = ?`,
	).bind(userId).first<InboxRow>();
}

function logFailure(step: string, failure: CfFailure): void {
	console.log(JSON.stringify({ event: "cloudflare_provision_failed", step, status: failure.status, code: failure.code }));
}

function failureError(failure: CfFailure, step: "upload" | "other"): ProvisionError {
	if (failure.status === 401 || failure.status === 403) return "forbidden";
	if (failure.status === 409) return "taken";
	return step === "upload" ? "partial" : "failed";
}

async function claim(db: Sql, input: { userId: string; workerName: string; host: SetupHost; now: number }): Promise<{ kind: "go" | "busy" | "ready"; row: InboxRow | null }> {
	const stamp = new Date(input.now).toISOString();
	const cutoff = new Date(input.now - WORKING_MS).toISOString();
	const result = await db.prepare(
		`INSERT INTO cloudflare_inbox (
		   "userId", cf_account_id, worker_name, d1_name, d1_id, public_url, owner_token_hash, host, hostname, status, created_at, updated_at
		 ) VALUES (?, '', ?, ?, NULL, NULL, NULL, ?, NULL, 'working', ?, ?)
		 ON CONFLICT ("userId") DO UPDATE SET status = 'working', updated_at = excluded.updated_at
		 WHERE cloudflare_inbox.status != 'ready'
		   AND (cloudflare_inbox.status != 'working' OR cloudflare_inbox.updated_at <= ?)`,
	).bind(input.userId, input.workerName, input.workerName, input.host, stamp, stamp, cutoff).run();
	const row = await readCloudflareInbox(db, input.userId);
	if (result.meta?.changes === 1) return { kind: "go", row };
	if (row?.status === "ready" && row.public_url) return { kind: "ready", row };
	return { kind: "busy", row };
}

async function patchInbox(db: Sql, userId: string, now: number, fields: {
	status?: string;
	cfAccountId?: string;
	d1Id?: string;
	publicUrl?: string;
	ownerTokenHash?: string;
	hostname?: string | null;
	workerName?: string;
}): Promise<void> {
	const row = await readCloudflareInbox(db, userId);
	if (!row) return;
	await db.prepare(
		`UPDATE cloudflare_inbox SET
		   status = ?, cf_account_id = ?, d1_id = ?, public_url = ?, owner_token_hash = ?, hostname = ?, worker_name = ?, d1_name = ?, updated_at = ?
		 WHERE "userId" = ?`,
	).bind(
		fields.status ?? row.status,
		fields.cfAccountId ?? row.cf_account_id,
		fields.d1Id ?? row.d1_id,
		fields.publicUrl ?? row.public_url,
		fields.ownerTokenHash ?? row.owner_token_hash,
		fields.hostname === undefined ? row.hostname : fields.hostname,
		fields.workerName ?? row.worker_name,
		fields.workerName ?? row.d1_name,
		new Date(now).toISOString(),
		userId,
	).run();
}

async function releaseClaim(db: Sql, userId: string): Promise<void> {
	const row = await readCloudflareInbox(db, userId);
	if (!row || row.d1_id || row.public_url) {
		if (row && row.status === "working") await patchInbox(db, userId, Date.now(), { status: "pending" });
		return;
	}
	await db.prepare(`DELETE FROM cloudflare_inbox WHERE "userId" = ? AND d1_id IS NULL AND public_url IS NULL`).bind(userId).run();
}

function scriptMetadata(input: { d1Id: string; publicUrl: string; workerName: string; ownerToken: string }) {
	return {
		main_module: "index.js",
		compatibility_date: INBOX_COMPATIBILITY_DATE,
		bindings: [
			{ type: "d1", name: "DB", id: input.d1Id },
			{ type: "plain_text", name: "PUBLIC_URL", text: input.publicUrl },
			{ type: "plain_text", name: "AGENT_NAME", text: input.workerName },
			{ type: "plain_text", name: "PAIRING_APPROVAL", text: "human" },
			{ type: "plain_text", name: "WAKE_PRESET", text: "generic" },
			{ type: "secret_text", name: "OWNER_TOKEN", text: input.ownerToken },
		],
	};
}

async function applyMigrations(input: {
	fetchImpl: typeof fetch;
	token: string;
	fetchMs: number;
	accountId: string;
	databaseId: string;
	migrations: InboxMigration[];
}): Promise<true | CfFailure> {
	const created = await d1Query({ ...input, sql: MIGRATIONS_TABLE });
	if (!Array.isArray(created)) return created;
	const existing = await d1Query({ ...input, sql: "SELECT name FROM d1_migrations" });
	if (!Array.isArray(existing)) return existing;
	const done = new Set(existing.map((row) => String(row.name ?? "")));
	for (const migration of input.migrations) {
		if (done.has(migration.name)) continue;
		for (const statement of sqlStatements(migration.sql)) {
			const applied = await d1Query({ ...input, sql: statement });
			if (!Array.isArray(applied)) return applied;
		}
		const recorded = await d1Query({
			...input,
			sql: "INSERT INTO d1_migrations (name) VALUES (?)",
			params: [migration.name],
		});
		if (!Array.isArray(recorded)) return recorded;
	}
	return true;
}

export function fieldsFromForm(form: FormData): ProvisionFields {
	const text = (key: string, max: number) => String(form.get(key) ?? "").trim().slice(0, max);
	return {
		name: text("name", 80).toLowerCase(),
		hostname: normalizeHostname(text("hostname", 300)),
		subdomain: text("subdomain", 80).toLowerCase(),
		account: text("account", 80),
	};
}

export function resumeFields(value: { name?: unknown; hostname?: unknown; subdomain?: unknown; account?: unknown }): ProvisionFields | null {
	const name = typeof value.name === "string" ? value.name : "";
	const hostname = typeof value.hostname === "string" ? value.hostname : "";
	const subdomain = typeof value.subdomain === "string" ? value.subdomain : "";
	const account = typeof value.account === "string" ? value.account : "";
	if (name.length > 63 || hostname.length > 253 || subdomain.length > 63 || account.length > 64) return null;
	return { name, hostname, subdomain, account };
}

/**
 * Creates the inbox for the saved choice. A ready inbox is returned without calling
 * Cloudflare again, and without the owner token. A façade is not created.
 */
export async function provisionInbox(input: {
	database: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	fields: ProvisionFields;
	script: string;
	migrations: InboxMigration[];
	fetchMs?: number;
	now?: number;
	fetchImpl?: typeof fetch;
}): Promise<ProvisionOutcome> {
	const now = input.now ?? Date.now();
	const fetchMs = input.fetchMs ?? 10_000;
	const fetchImpl = input.fetchImpl ?? fetch;
	const grant = await readCloudflareGrant(input.database, input.userId);
	if (!grant) return { ok: false, error: "no_grant" };
	const choice = parseSetupChoice(grant.choice);
	const host = parseSetupHost(grant.host);
	if (!choice || !host) return { ok: false, error: "no_grant" };
	if (!inboxCanProvision(grant)) return { ok: false, error: "blocked" };
	const existing = await readCloudflareInbox(input.database, input.userId);
	if (existing?.status === "ready" && existing.public_url) {
		return { ok: true, publicUrl: existing.public_url, ownerToken: null, facade: choice !== "inbox" };
	}
	const planned = planNames(host, input.fields, existing);
	if (!planned.ok) return planned;
	if (!input.script.trim() || input.script.length > 5_000_000 || !input.migrations.length) return { ok: false, error: "script" };

	const claimed = await claim(input.database, { userId: input.userId, workerName: planned.workerName, host, now });
	if (claimed.kind === "busy") return { ok: false, error: "busy" };
	if (claimed.kind === "ready" && claimed.row?.public_url) {
		return { ok: true, publicUrl: claimed.row.public_url, ownerToken: null, facade: choice !== "inbox" };
	}
	const row = claimed.row ?? existing;
	const workerName = row?.d1_id ? row.worker_name : planned.workerName;

	const refreshed = await refreshCloudflareGrant({
		database: input.database,
		secret: input.secret,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		userId: input.userId,
		fetchMs: Math.min(fetchMs, 5_000),
		now,
	});
	if (!refreshed.ok) {
		await releaseClaim(input.database, input.userId);
		if (refreshed.error === "invalid_grant" || refreshed.error === "no_refresh" || refreshed.error === "unreadable") return { ok: false, error: "invalid_grant" };
		if (refreshed.error === "busy") return { ok: false, error: "busy" };
		return { ok: false, error: "failed" };
	}
	const token = refreshed.accessToken;
	const api = { fetchImpl, token, fetchMs };

	try {
		const accounts = await listAccounts(api);
		if (!Array.isArray(accounts)) {
			logFailure("accounts", accounts);
			await releaseClaim(input.database, input.userId);
			return { ok: false, error: failureError(accounts, "other") };
		}
		const account = pickAccount(accounts, input.fields.account);
		if (!account) {
			await releaseClaim(input.database, input.userId);
			return accounts.length ? { ok: false, error: "account", accounts } : { ok: false, error: "failed" };
		}

		let hostname = "";
		let zoneId = "";
		let publicUrl = "";
		if (host === "zone") {
			const zones = await listZones({ ...api, accountId: account.id });
			if (!Array.isArray(zones)) {
				logFailure("zones", zones);
				await releaseClaim(input.database, input.userId);
				return { ok: false, error: failureError(zones, "other") };
			}
			const zone = zoneForHostname(planned.hostname, zones);
			if (!zone) {
				await releaseClaim(input.database, input.userId);
				return { ok: false, error: "zone", zones: activeZoneNames(zones) };
			}
			hostname = planned.hostname;
			zoneId = zone.id;
			publicUrl = `https://${hostname}`;
		} else {
			const subdomain = await ensureSubdomain({ ...api, accountId: account.id, requested: input.fields.subdomain });
			if (typeof subdomain !== "string") {
				await releaseClaim(input.database, input.userId);
				return subdomain;
			}
			publicUrl = `https://${workerName}.${subdomain}.workers.dev`;
		}

		const before = await guardExistingScript(api, account.id, workerName, input.database, input.userId);
		if (before !== true) return before;

		let d1Id = row?.d1_id ?? "";
		if (!d1Id) {
			const found = await findD1({ ...api, accountId: account.id, name: workerName });
			if (found && !("uuid" in found)) {
				logFailure("d1-list", found);
				await releaseClaim(input.database, input.userId);
				return { ok: false, error: failureError(found, "other") };
			}
			if (found && "uuid" in found) {
				await releaseClaim(input.database, input.userId);
				return { ok: false, error: "taken" };
			}
			const created = await createD1({ ...api, accountId: account.id, name: workerName });
			if (!("uuid" in created)) {
				logFailure("d1-create", created);
				await releaseClaim(input.database, input.userId);
				return { ok: false, error: created.status === 409 ? "taken" : failureError(created, "other") };
			}
			d1Id = created.uuid;
			await patchInbox(input.database, input.userId, now, { d1Id, cfAccountId: account.id, workerName, status: "pending" });
		} else {
			await patchInbox(input.database, input.userId, now, { cfAccountId: account.id, status: "working" });
		}

		const migrated = await applyMigrations({ ...api, accountId: account.id, databaseId: d1Id, migrations: input.migrations });
		if (migrated !== true) {
			logFailure("migrations", migrated);
			await patchInbox(input.database, input.userId, now, { status: "pending", d1Id, cfAccountId: account.id });
			return { ok: false, error: "partial" };
		}

		const again = await guardExistingScript(api, account.id, workerName, input.database, input.userId);
		if (again !== true) return again;

		const ownerToken = newOwnerToken();
		const uploaded = await uploadWorker({
			...api,
			fetchMs: Math.max(fetchMs, 20_000),
			accountId: account.id,
			name: workerName,
			script: input.script,
			metadata: scriptMetadata({ d1Id, publicUrl, workerName, ownerToken }),
		});
		if (uploaded !== true) {
			logFailure("upload", uploaded);
			await patchInbox(input.database, input.userId, now, { status: "pending", d1Id, cfAccountId: account.id });
			return { ok: false, error: failureError(uploaded, "upload") };
		}

		if (host === "workers") {
			const enabled = await setWorkersDevEnabled({ ...api, accountId: account.id, name: workerName, enabled: true });
			if (enabled !== true) {
				logFailure("workers-dev", enabled);
				await patchInbox(input.database, input.userId, now, { status: "pending", d1Id, cfAccountId: account.id });
				return { ok: false, error: "partial" };
			}
		} else {
			const attached = await attachHostname({ ...api, accountId: account.id, workerName, hostname, zoneId });
			if (attached !== true) {
				logFailure("hostname", attached);
				await patchInbox(input.database, input.userId, now, { status: "pending", d1Id, cfAccountId: account.id });
				return { ok: false, error: failureError(attached, "upload") };
			}
			const disabled = await setWorkersDevEnabled({ ...api, accountId: account.id, name: workerName, enabled: false });
			if (disabled !== true && disabled.status !== 404) logFailure("workers-dev-off", disabled);
		}

		const ownerTokenHash = await hashOwnerToken(ownerToken);
		await patchInbox(input.database, input.userId, now, {
			status: "ready",
			d1Id,
			cfAccountId: account.id,
			workerName,
			publicUrl,
			ownerTokenHash,
			hostname: hostname || null,
		});
		return { ok: true, publicUrl, ownerToken, facade: choice !== "inbox" };
	} catch (error) {
		console.log(JSON.stringify({ event: "cloudflare_provision_failed", step: "unexpected", status: 0, code: null, name: error instanceof Error ? error.name : "Error" }));
		await patchInbox(input.database, input.userId, now, { status: "pending" }).catch(() => {});
		return { ok: false, error: "failed" };
	}
}

/** Refuses a Worker this page did not upload. Missing, or a script that still has the inbox banner, may continue. */
async function guardExistingScript(
	api: { fetchImpl: typeof fetch; token: string; fetchMs: number },
	accountId: string,
	name: string,
	database: Sql,
	userId: string,
): Promise<true | ProvisionOutcome> {
	const state = await inboxScriptOwnership({ ...api, accountId, name });
	if (state === "missing" || state === "ours") return true;
	if (state === "other") {
		await releaseClaim(database, userId);
		return { ok: false, error: "taken" };
	}
	logFailure("worker", state);
	await releaseClaim(database, userId);
	return { ok: false, error: failureError(state, "other") };
}

function planNames(host: SetupHost, fields: ProvisionFields, existing: InboxRow | null): { ok: true; workerName: string; hostname: string } | { ok: false; error: ProvisionError } {
	if (host === "workers") {
		const workerName = existing?.d1_id ? existing.worker_name : fields.name;
		if (!LABEL_RE.test(workerName)) return { ok: false, error: "name" };
		if (fields.subdomain && !LABEL_RE.test(fields.subdomain)) return { ok: false, error: "subdomain" };
		return { ok: true, workerName, hostname: "" };
	}
	if (!HOST_RE.test(fields.hostname) || fields.hostname.endsWith(".workers.dev")) return { ok: false, error: "hostname" };
	const workerName = existing?.d1_id ? existing.worker_name : workerNameFromHostname(fields.hostname);
	if (!workerName) return { ok: false, error: "hostname" };
	return { ok: true, workerName, hostname: fields.hostname };
}

function pickAccount(accounts: CfAccount[], requested: string): CfAccount | null {
	if (requested) return accounts.find((account) => account.id === requested) ?? null;
	return accounts.length === 1 ? accounts[0]! : null;
}

function activeZoneNames(zones: CfZone[]): { name: string }[] {
	return zones.filter((zone) => zone.status === "active").map((zone) => ({ name: zone.name }));
}

async function ensureSubdomain(input: {
	fetchImpl: typeof fetch;
	token: string;
	fetchMs: number;
	accountId: string;
	requested: string;
}): Promise<string | ProvisionOutcome> {
	const current = await workersDevSubdomain(input);
	if (typeof current !== "string") {
		logFailure("subdomain", current);
		return { ok: false, error: failureError(current, "other") };
	}
	if (current) return current;
	if (!input.requested) return { ok: false, error: "need_subdomain" };
	if (!LABEL_RE.test(input.requested)) return { ok: false, error: "subdomain" };
	const registered = await registerWorkersDevSubdomain({ ...input, subdomain: input.requested });
	if (registered !== true) {
		logFailure("subdomain-create", registered);
		return { ok: false, error: registered.status === 409 ? "subdomain" : failureError(registered, "other") };
	}
	return input.requested;
}
