// Creates an inbox in the user's Cloudflare account from the saved OAuth grant.
// The access token is used for that request and is not stored. The owner token is
// uploaded as a Worker secret and only its SHA-256 hash is kept here.

import { describeSetupGrant, inboxCanProvision, parseSetupChoice, parseSetupHost, type SetupHost } from "../auth/cloudflare-setup.ts";
import { readCloudflareGrant, refreshCloudflareGrant } from "../auth/cloudflare-grant.ts";
import type { Sql } from "../auth/invites.ts";
import { hashOwnerToken, readCloudflareInbox, type InboxRow } from "./inbox-row.ts";
import { newOwnerToken } from "../tenants/create.ts";
import {
	attachHostname,
	createD1,
	describeCfFailure,
	sanitizeCloudflareText,
	d1Query,
	findD1,
	listAccounts,
	listZones,
	registerWorkersDevSubdomain,
	setWorkersDevEnabled,
	permissionNotReady,
	subdomainMissing,
	uploadWorker,
	workerProvisionTag,
	PROVISION_TAG_NAME,
	workersDevSubdomain,
	callFetch,
	type CfAccount,
	type CfFailure,
	type CfZone,
} from "./cloudflare-api.ts";
import { HOST_RE, LABEL_RE, normalizeHostname, workerNameFromHostname, zoneForHostname } from "./names.ts";
import { sqlStatements } from "./statements.ts";

export { hashOwnerToken, readCloudflareInbox };
export type { InboxRow };

/** Keep in step with worker/cloudflare.config.ts compatibilityDate. */
export const INBOX_COMPATIBILITY_DATE = "2026-10-06";

/** One file from worker/migrations, applied in order. */
export interface InboxMigration {
	name: string;
	sql: string;
}

const WORKING_MS = 2 * 60 * 1000;
/** Shown while a just-granted permission has not reached D1 or the script upload yet. */
export const PERMISSION_WAIT = "Waiting for Cloudflare to apply the new permission…";
/** Four tries: the first call, then these pauses. About 15 seconds in all. */
export const PERMISSION_DELAYS_MS = [2_000, 4_000, 8_000];
export const PERMISSION_TRIES = 4;
const MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

export interface ProvisionFields {
	name: string;
	hostname: string;
	subdomain: string;
	account: string;
	step: string;
}

export const WIZARD_STEPS = ["grant", "account", "address", "name", "database", "migrations", "upload", "verify"] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];
export type WizardState = "pass" | "fail" | "fixable" | "wait";
export type WizardControl = "" | "retry" | "continue" | "account" | "subdomain" | "name" | "hostname";

export interface WizardStepView {
	id: WizardStepId;
	title: string;
	hint: string;
	state: WizardState;
	text: string;
	cloudflare: string;
	control: WizardControl;
	button: string;
}

export interface InboxWizard {
	steps: WizardStepView[];
	fields: ProvisionFields;
	accounts?: { id: string; name: string }[];
	zones?: { name: string }[];
	ownerToken?: string;
	publicUrl: string | null;
	facade: boolean;
	host: SetupHost;
	/** Seconds until the browser reloads this page to try the permission again. */
	refreshSeconds?: number;
}

interface StoredStepNote {
	step: WizardStepId;
	state: "fail" | "fixable" | "wait";
	text: string;
	cloudflare: string;
	/** Permission tries already made for this step. The next one adds one. */
	permissionTries?: number;
	/** Earliest time the page may try this step again. */
	retryAt?: number;
	accounts?: { id: string; name: string }[];
	zones?: { name: string }[];
	/** When set, the name step can be chosen again. */
	reopenName?: boolean;
	/** Typed values to show again after a refresh. */
	name?: string;
	hostname?: string;
	subdomain?: string;
}

function logFailure(step: string, failure: CfFailure, attempt?: number): void {
	const line: Record<string, unknown> = {
		event: "cloudflare_provision_failed",
		step,
		status: failure.status,
		errors: failure.errors ?? [],
	};
	if (attempt) line.attempt = attempt;
	if (failure.thrown) {
		line.name = failure.thrown.name;
		line.message = failure.thrown.message;
	}
	console.log(JSON.stringify(line));
}

async function beginStep(db: Sql, userId: string, host: SetupHost, now: number): Promise<"go" | "busy" | "ready"> {
	const stamp = new Date(now).toISOString();
	const cutoff = new Date(now - WORKING_MS).toISOString();
	const result = await db.prepare(
		`INSERT INTO cloudflare_inbox (
		   "userId", cf_account_id, worker_name, d1_name, d1_id, public_url, owner_token_hash, host, hostname, status, created_at, updated_at
		 ) VALUES (?, '', '', '', NULL, NULL, NULL, ?, NULL, 'working', ?, ?)
		 ON CONFLICT ("userId") DO UPDATE SET status = 'working', updated_at = excluded.updated_at
		 WHERE cloudflare_inbox.status != 'ready'
		   AND (cloudflare_inbox.status != 'working' OR cloudflare_inbox.updated_at <= ?)`,
	).bind(userId, host, stamp, stamp, cutoff).run();
	const row = await readCloudflareInbox(db, userId);
	if (row?.status === "ready" && row.public_url) return "ready";
	return result.meta?.changes === 1 ? "go" : "busy";
}

async function patchInbox(db: Sql, userId: string, now: number, fields: {
	status?: string;
	cfAccountId?: string;
	d1Id?: string | null;
	publicUrl?: string | null;
	ownerTokenHash?: string;
	hostname?: string | null;
	workerName?: string;
	scriptTag?: string;
	wizardStep?: string | null;
	workersSubdomain?: string | null;
	stepError?: string | null;
}): Promise<void> {
	const row = await readCloudflareInbox(db, userId);
	if (!row) return;
	await db.prepare(
		`UPDATE cloudflare_inbox SET
		   status = ?, cf_account_id = ?, d1_id = ?, public_url = ?, owner_token_hash = ?, hostname = ?, worker_name = ?, d1_name = ?, script_tag = ?,
		   wizard_step = ?, workers_subdomain = ?, step_error = ?, updated_at = ?
		 WHERE "userId" = ?`,
	).bind(
		fields.status ?? row.status,
		fields.cfAccountId ?? row.cf_account_id,
		fields.d1Id === undefined ? row.d1_id : fields.d1Id,
		fields.publicUrl === undefined ? row.public_url : fields.publicUrl,
		fields.ownerTokenHash ?? row.owner_token_hash,
		fields.hostname === undefined ? row.hostname : fields.hostname,
		fields.workerName ?? row.worker_name,
		fields.workerName ?? row.d1_name,
		fields.scriptTag ?? row.script_tag,
		fields.wizardStep === undefined ? row.wizard_step : fields.wizardStep,
		fields.workersSubdomain === undefined ? row.workers_subdomain : fields.workersSubdomain,
		fields.stepError === undefined ? row.step_error : fields.stepError,
		new Date(now).toISOString(),
		userId,
	).run();
}

async function releaseWorking(db: Sql, userId: string, now: number): Promise<void> {
	const row = await readCloudflareInbox(db, userId);
	if (row?.status === "working") await patchInbox(db, userId, now, { status: "pending" });
}

function scriptMetadata(input: { d1Id: string; publicUrl: string; workerName: string; ownerToken: string; scriptTag: string }) {
	return {
		main_module: "index.js",
		compatibility_date: INBOX_COMPATIBILITY_DATE,
		bindings: [
			{ type: "d1", name: "DB", id: input.d1Id },
			{ type: "plain_text", name: "PUBLIC_URL", text: input.publicUrl },
			{ type: "plain_text", name: "AGENT_NAME", text: input.workerName },
			{ type: "plain_text", name: "PAIRING_APPROVAL", text: "human" },
			{ type: "plain_text", name: "WAKE_PRESET", text: "generic" },
			{ type: "plain_text", name: PROVISION_TAG_NAME, text: input.scriptTag },
			{ type: "secret_text", name: "OWNER_TOKEN", text: input.ownerToken },
		],
	};
}

function newScriptTag(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameTag(left: string, right: string): boolean {
	if (left.length !== right.length || !left) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
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

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function fieldsFromForm(form: FormData): ProvisionFields {
	const text = (key: string, max: number) => String(form.get(key) ?? "").trim().slice(0, max);
	return {
		name: text("name", 80).toLowerCase(),
		hostname: normalizeHostname(text("hostname", 300)),
		subdomain: text("subdomain", 80).toLowerCase(),
		account: text("account", 80),
		step: text("step", 32),
	};
}

export function resumeFields(value: { name?: unknown; hostname?: unknown; subdomain?: unknown; account?: unknown; step?: unknown }): ProvisionFields | null {
	const name = typeof value.name === "string" ? value.name : "";
	const hostname = typeof value.hostname === "string" ? value.hostname : "";
	const subdomain = typeof value.subdomain === "string" ? value.subdomain : "";
	const account = typeof value.account === "string" ? value.account : "";
	const step = typeof value.step === "string" ? value.step : "";
	if (name.length > 63 || hostname.length > 253 || subdomain.length > 63 || account.length > 64 || step.length > 32) return null;
	if (step && !isStep(step)) return null;
	return { name, hostname, subdomain, account, step };
}

function isStep(value: string): value is WizardStepId {
	return (WIZARD_STEPS as readonly string[]).includes(value);
}

function lastPassed(row: InboxRow | null): WizardStepId | null {
	if (!row) return null;
	if (row.status === "ready" && row.public_url) return "verify";
	if (row.wizard_step && isStep(row.wizard_step) && row.wizard_step !== "grant" && row.wizard_step !== "verify") return row.wizard_step;
	if (row.d1_id) return "database";
	if (row.worker_name) return "name";
	if (row.workers_subdomain || row.hostname) return "address";
	if (row.cf_account_id) return "account";
	return null;
}

function nextId(passed: WizardStepId | null): WizardStepId {
	if (!passed) return "account";
	return WIZARD_STEPS[WIZARD_STEPS.indexOf(passed) + 1] ?? "verify";
}

function shownFields(row: InboxRow | null, fields: ProvisionFields | null | undefined, note: StoredStepNote | null): ProvisionFields {
	return {
		name: fields?.name || note?.name || row?.worker_name || "",
		hostname: fields?.hostname || note?.hostname || row?.hostname || "",
		subdomain: fields?.subdomain || note?.subdomain || "",
		account: fields?.account || row?.cf_account_id || "",
		step: "",
	};
}

function stepMeta(id: WizardStepId, host: SetupHost): { title: string; hint: string } {
	switch (id) {
		case "grant": return { title: "Cloudflare connection", hint: "Permissions" };
		case "account": return { title: "Cloudflare account", hint: "Account" };
		case "address": return host === "zone"
			? { title: "Your web address", hint: "Domain" }
			: { title: "Free address name", hint: "workers.dev" };
		case "name": return { title: "Inbox name", hint: "Worker" };
		case "database": return { title: "Database", hint: "D1" };
		case "migrations": return { title: "Database setup", hint: "Migrations" };
		case "upload": return { title: "Inbox upload", hint: "Worker" };
		case "verify": return { title: "Inbox answers", hint: "Address" };
	}
}

function passText(id: WizardStepId, host: SetupHost, row: InboxRow | null): string {
	switch (id) {
		case "grant": return "Cloudflare is connected, and the permissions this inbox needs are granted.";
		case "account": return "This Cloudflare account is selected.";
		case "address": return host === "zone"
			? "This address is on a domain in this Cloudflare account."
			: row?.workers_subdomain
				? `This account has the free address name ${row.workers_subdomain}.`
				: "This account has a free address name.";
		case "name": return "This name is free.";
		case "database": return "The database is created.";
		case "migrations": return "The database setup is applied.";
		case "upload": return "The inbox is uploaded.";
		case "verify": return "The inbox answers.";
	}
}

function continueButton(id: WizardStepId, host: SetupHost): string {
	switch (id) {
		case "address": return host === "zone" ? "Check this address" : "Check the workers.dev name";
		case "name": return "Check this name";
		case "database": return "Create the database";
		case "migrations": return "Apply the database setup";
		case "upload": return "Upload the inbox";
		case "verify": return "Check that the inbox answers";
		default: return "Check the Cloudflare account";
	}
}

function controlFor(note: StoredStepNote, host: SetupHost): { control: WizardControl; button: string } {
	if (note.state === "wait") return { control: "", button: "" };
	if (note.state === "fail") return { control: "retry", button: "Try again" };
	if (note.accounts?.length) return { control: "account", button: "Use this account" };
	if (note.step === "address" && host === "workers") return { control: "subdomain", button: "Create this workers.dev name" };
	if (note.step === "address") return { control: "hostname", button: "Check this address" };
	if (note.step === "name" && host === "workers") return { control: "name", button: "Check this name" };
	if (note.step === "name") return { control: "hostname", button: "Check this address" };
	return { control: "retry", button: "Try again" };
}

function readNote(raw: string | null | undefined): StoredStepNote | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const note = parsed as StoredStepNote;
	if (!isStep(note.step) || (note.state !== "fail" && note.state !== "fixable" && note.state !== "wait")) return null;
	if (typeof note.text !== "string" || typeof note.cloudflare !== "string") return null;
	const accounts = Array.isArray(note.accounts)
		? note.accounts.filter((account) => account && ID_RE.test(account.id) && typeof account.name === "string").slice(0, 12)
		: [];
	const zones = Array.isArray(note.zones)
		? note.zones.filter((zone) => zone && typeof zone.name === "string" && zone.name.length > 0 && zone.name.length <= 253).slice(0, 20)
		: [];
	const name = typeof note.name === "string" ? note.name.slice(0, 63) : "";
	const hostname = typeof note.hostname === "string" ? note.hostname.slice(0, 253) : "";
	const subdomain = typeof note.subdomain === "string" ? note.subdomain.slice(0, 63) : "";
	const permissionTries = Number.isInteger(note.permissionTries) && (note.permissionTries ?? 0) >= 1 && (note.permissionTries ?? 0) < PERMISSION_TRIES
		? note.permissionTries
		: undefined;
	const retryAt = typeof note.retryAt === "number" && Number.isFinite(note.retryAt) && note.retryAt > 0 && note.retryAt < 1e15
		? note.retryAt
		: undefined;
	return {
		step: note.step,
		state: note.state,
		text: note.text.slice(0, 400),
		cloudflare: note.cloudflare.slice(0, 400),
		...(accounts.length ? { accounts: accounts.map((account) => ({ id: account.id, name: account.name.slice(0, 80) })) } : {}),
		...(zones.length ? { zones: zones.map((zone) => ({ name: zone.name.slice(0, 80) })) } : {}),
		...(note.reopenName ? { reopenName: true } : {}),
		...(name ? { name } : {}),
		...(hostname ? { hostname } : {}),
		...(subdomain ? { subdomain } : {}),
		...(note.state === "wait" && permissionTries ? { permissionTries } : {}),
		...(note.state === "wait" && retryAt ? { retryAt } : {}),
	};
}

function noteJson(note: StoredStepNote): string {
	const text = sanitizeCloudflareText(note.text).slice(0, 400);
	const cloudflare = sanitizeCloudflareText(note.cloudflare).slice(0, 400);
	return JSON.stringify({
		step: note.step,
		state: note.state,
		text,
		cloudflare,
		...(note.accounts?.length ? { accounts: note.accounts.slice(0, 12).map((account) => ({ id: account.id, name: account.name.slice(0, 80) })) } : {}),
		...(note.zones?.length ? { zones: note.zones.slice(0, 20).map((zone) => ({ name: zone.name.slice(0, 80) })) } : {}),
		...(note.reopenName ? { reopenName: true } : {}),
		...(note.name ? { name: note.name.slice(0, 63) } : {}),
		...(note.hostname ? { hostname: note.hostname.slice(0, 253) } : {}),
		...(note.subdomain ? { subdomain: note.subdomain.slice(0, 63) } : {}),
		...(note.state === "wait" && note.permissionTries ? { permissionTries: note.permissionTries } : {}),
		...(note.state === "wait" && note.retryAt ? { retryAt: note.retryAt } : {}),
	});
}

function grantBlock(grant: { choice: string; host: string; granted_scope: string | null; refresh_enc: string | null }): string {
	const report = describeSetupGrant(grant);
	if (!report) return "Choose a setup before creating an inbox.";
	if (report.blocked.length) return report.blocked.join(" ");
	return "Cloudflare has not granted every permission this inbox needs.";
}

function blankWizard(fields: ProvisionFields, host: SetupHost, text: string): InboxWizard {
	const steps = WIZARD_STEPS.map((id): WizardStepView => {
		const meta = stepMeta(id, host);
		if (id === "grant") return { ...meta, id, state: "fixable", text, cloudflare: "", control: "", button: "" };
		return { ...meta, id, state: "wait", text: "Not checked yet.", cloudflare: "", control: "", button: "" };
	});
	return { steps, fields, publicUrl: null, facade: false, host };
}

/** The wizard as it stands, with no Cloudflare call. A stored note stays on the step that wrote it. */
export function viewInboxWizard(input: {
	grant: { choice: string; host: string; granted_scope: string | null; refresh_enc: string | null } | null;
	inbox: InboxRow | null;
	fields?: ProvisionFields | null;
	overlay?: StoredStepNote | null;
}): InboxWizard {
	const host = parseSetupHost(input.grant?.host) ?? "workers";
	const stored = input.overlay ?? readNote(input.inbox?.step_error);
	const fields = shownFields(input.inbox, input.fields, stored);
	const choice = input.grant ? parseSetupChoice(input.grant.choice) : null;
	if (!input.grant || !choice || !parseSetupHost(input.grant.host)) {
		return blankWizard(fields, host, "Choose a setup before creating an inbox.");
	}
	const can = inboxCanProvision(input.grant);
	const done = Boolean(input.inbox?.status === "ready" && input.inbox.public_url);
	const passed = done ? "verify" : lastPassed(input.inbox);
	const passedIndex = passed ? WIZARD_STEPS.indexOf(passed) : -1;
	const next = !can || done ? null : nextId(passed);
	const note = stored;
	const report = describeSetupGrant(input.grant);
	const steps = WIZARD_STEPS.map((id): WizardStepView => {
		const meta = stepMeta(id, host);
		if (id === "grant") {
			return can
				? { ...meta, id, state: "pass", text: passText(id, host, input.inbox), cloudflare: "", control: "", button: "" }
				: { ...meta, id, state: "fixable", text: grantBlock(input.grant!), cloudflare: "", control: "", button: "" };
		}
		const index = WIZARD_STEPS.indexOf(id);
		if (can && index <= passedIndex) {
			return { ...meta, id, state: "pass", text: passText(id, host, input.inbox), cloudflare: "", control: "", button: "" };
		}
		if (id === next) {
			if (note && note.step === id) {
				const ui = controlFor(note, host);
				return { ...meta, id, state: note.state, text: note.text, cloudflare: note.cloudflare, control: ui.control, button: ui.button };
			}
			if (id === "address" && host === "zone") {
				return { ...meta, id, state: "fixable", text: "Type the web address for this inbox.", cloudflare: "", control: "hostname", button: "Check this address" };
			}
			if (id === "name" && host === "workers") {
				return { ...meta, id, state: "fixable", text: "Type a name for this inbox.", cloudflare: "", control: "name", button: "Check this name" };
			}
			return { ...meta, id, state: "wait", text: "Not checked yet.", cloudflare: "", control: "continue", button: continueButton(id, host) };
		}
		return { ...meta, id, state: "wait", text: "Not checked yet.", cloudflare: "", control: "", button: "" };
	});
	const waiting = Boolean(note && note.state === "wait" && note.step === next && typeof note.retryAt === "number");
	const refreshSeconds = waiting
		? Math.max(1, Math.ceil(((note?.retryAt ?? 0) - Date.now()) / 1000))
		: undefined;
	return {
		steps,
		fields,
		accounts: note && note.step === next ? note.accounts : undefined,
		zones: note && note.step === next ? note.zones : undefined,
		publicUrl: done ? input.inbox?.public_url ?? null : null,
		facade: Boolean(report?.facade),
		host,
		...(refreshSeconds ? { refreshSeconds } : {}),
	};
}

/** True when this page should try the waiting step again. A future `retryAt` waits. */
export function permissionRetryDue(inbox: InboxRow | null, now = Date.now()): boolean {
	if (!inbox || inbox.status === "ready") return false;
	const note = readNote(inbox.step_error);
	if (!note || note.state !== "wait") return false;
	if (typeof note.retryAt !== "number") return true;
	return now >= note.retryAt;
}

interface StepCtx {
	db: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	now: number;
	fetchMs: number;
	fetchImpl: typeof fetch;
	token: string;
	host: SetupHost;
	fields: ProvisionFields;
	row: InboxRow;
	script: string;
	migrations: InboxMigration[];
	grant: { choice: string; host: string; granted_scope: string | null; refresh_enc: string | null };
	permissionDelaysMs: number[];
}

async function wizardNow(ctx: StepCtx, overlay?: StoredStepNote | null): Promise<InboxWizard> {
	const inbox = await readCloudflareInbox(ctx.db, ctx.userId);
	return viewInboxWizard({ grant: ctx.grant, inbox, fields: ctx.fields, overlay });
}

function noted(ctx: StepCtx, note: StoredStepNote): StoredStepNote {
	return {
		...note,
		...(ctx.fields.name ? { name: ctx.fields.name } : {}),
		...(ctx.fields.hostname ? { hostname: ctx.fields.hostname } : {}),
		...(ctx.fields.subdomain ? { subdomain: ctx.fields.subdomain } : {}),
	};
}

async function remember(ctx: StepCtx, note: StoredStepNote): Promise<InboxWizard> {
	await patchInbox(ctx.db, ctx.userId, ctx.now, { stepError: noteJson(noted(ctx, note)), status: "pending" });
	return wizardNow(ctx);
}

/**
 * A permission that was just granted can fail the first calls. Try again after a
 * short pause, up to 4 times. Other failures show immediately.
 */
async function failOrWait(ctx: StepCtx, step: WizardStepId, failure: CfFailure, text: string, logStep: string): Promise<InboxWizard> {
	const previous = readNote(ctx.row.step_error);
	const tries = previous?.step === step && previous.permissionTries ? previous.permissionTries + 1 : 1;
	const permission = permissionNotReady(failure);
	logFailure(logStep, failure, permission ? tries : undefined);
	if (!permission || tries >= PERMISSION_TRIES) {
		return remember(ctx, { step, state: "fail", text, cloudflare: describeCfFailure(failure) });
	}
	const delay = ctx.permissionDelaysMs[tries - 1] ?? ctx.permissionDelaysMs.at(-1) ?? PERMISSION_DELAYS_MS.at(-1) ?? 8_000;
	return remember(ctx, {
		step,
		state: "wait",
		text: PERMISSION_WAIT,
		cloudflare: "",
		permissionTries: tries,
		retryAt: ctx.now + delay,
	});
}

function plannedUrl(row: InboxRow, host: SetupHost): string {
	if (host === "zone") return row.hostname ? `https://${row.hostname}` : "";
	if (row.worker_name && row.workers_subdomain) return `https://${row.worker_name}.${row.workers_subdomain}.workers.dev`;
	return "";
}

async function probeInbox(fetchImpl: typeof fetch, url: string, fetchMs: number): Promise<{ ok: true } | { ok: false; failure: CfFailure }> {
	try {
		const response = await callFetch(fetchImpl, `${url}/.well-known/agent-card.json`, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(fetchMs),
		});
		void response.body?.cancel().catch(() => {});
		if (response.status >= 200 && response.status < 300) return { ok: true };
		return { ok: false, failure: { ok: false, status: response.status, code: null, errors: [] } };
	} catch (error) {
		const name = error instanceof Error && error.name ? error.name.slice(0, 80) : "Error";
		const message = sanitizeCloudflareText(error instanceof Error ? error.message : "");
		return { ok: false, failure: { ok: false, status: 0, code: null, errors: [], thrown: { name, message } } };
	}
}

function activeZoneNames(zones: CfZone[]): { name: string }[] {
	return zones.filter((zone) => zone.status === "active").map((zone) => ({ name: zone.name }));
}

function refreshProblem(error: string): { state: "fail" | "fixable"; text: string } {
	if (error === "invalid_grant" || error === "no_refresh" || error === "unreadable" || error === "no_grant") {
		return { state: "fixable", text: "The saved Cloudflare permission expired. Choose the setup again." };
	}
	if (error === "busy") return { state: "fail", text: "A setup is already running. Try again in a moment." };
	if (error === "uncertain") return { state: "fail", text: "Cloudflare does not answer the permission refresh in time. Try again." };
	return { state: "fail", text: "Cloudflare stops while refreshing the saved permission. Try again." };
}

/**
 * Runs one wizard step and returns the page to show. An earlier step that already
 * passed is not repeated. A ready inbox does not call Cloudflare.
 */
export async function runInboxStep(input: {
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
	/** Pauses after a permission error. Tests pass zeros. Production waits about 15 seconds across 4 tries. */
	permissionDelaysMs?: number[];
}): Promise<{ wizard: InboxWizard; ownerToken?: string }> {
	const now = input.now ?? Date.now();
	const fetchMs = input.fetchMs ?? 10_000;
	const fetchImpl = input.fetchImpl ?? fetch;
	const grant = await readCloudflareGrant(input.database, input.userId);
	const host = parseSetupHost(grant?.host) ?? "workers";
	const fields = input.fields;
	if (!grant || !parseSetupChoice(grant.choice) || !parseSetupHost(grant.host)) {
		return { wizard: viewInboxWizard({ grant, inbox: await readCloudflareInbox(input.database, input.userId), fields }) };
	}
	const row = await readCloudflareInbox(input.database, input.userId);
	if (row?.status === "ready" && row.public_url) return { wizard: viewInboxWizard({ grant, inbox: row, fields }) };
	if (!inboxCanProvision(grant)) return { wizard: viewInboxWizard({ grant, inbox: row, fields }) };
	const next = nextId(lastPassed(row));
	const requested = fields.step && isStep(fields.step) ? fields.step : next;
	if (requested !== next) return { wizard: viewInboxWizard({ grant, inbox: row, fields }) };

	const claimed = await beginStep(input.database, input.userId, host, now);
	if (claimed === "ready") {
		return { wizard: viewInboxWizard({ grant, inbox: await readCloudflareInbox(input.database, input.userId), fields }) };
	}
	if (claimed === "busy") {
		const overlay: StoredStepNote = { step: next, state: "fail", text: "A setup is already running. Try again in a moment.", cloudflare: "" };
		return { wizard: viewInboxWizard({ grant, inbox: row, fields, overlay }) };
	}
	const locked = (await readCloudflareInbox(input.database, input.userId)) ?? row;
	if (!locked) {
		await releaseWorking(input.database, input.userId, now);
		return { wizard: viewInboxWizard({ grant, inbox: null, fields }) };
	}
	const ctx: StepCtx = {
		db: input.database,
		secret: input.secret,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		userId: input.userId,
		now,
		fetchMs,
		fetchImpl,
		token: "",
		host,
		fields,
		row: locked,
		script: input.script,
		migrations: input.migrations,
		grant,
		permissionDelaysMs: input.permissionDelaysMs ?? PERMISSION_DELAYS_MS,
	};
	try {
		if (next !== "verify") {
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
				const problem = refreshProblem(refreshed.error);
				return { wizard: await remember(ctx, { step: next, state: problem.state, text: problem.text, cloudflare: "" }) };
			}
			ctx.token = refreshed.accessToken;
		}
		const done = await runOne(ctx, next);
		return done;
	} catch (error) {
		const name = error instanceof Error && error.name ? error.name.slice(0, 80) : "Error";
		const message = sanitizeCloudflareText(error instanceof Error ? error.message : "");
		console.log(JSON.stringify({ event: "cloudflare_provision_failed", step: "unexpected", status: 0, errors: [], name, message }));
		const wizard = await remember(ctx, {
			step: next,
			state: "fail",
			text: "Cloudflare stops while running this step.",
			cloudflare: message ? `The request stops before Cloudflare answers (${name}: ${message}).` : `The request stops before Cloudflare answers (${name}).`,
		}).catch(() => viewInboxWizard({ grant, inbox: locked, fields }));
		return { wizard };
	} finally {
		await releaseWorking(input.database, input.userId, now).catch(() => {});
	}
}

async function runOne(ctx: StepCtx, step: WizardStepId): Promise<{ wizard: InboxWizard; ownerToken?: string }> {
	switch (step) {
		case "account": return { wizard: await runAccount(ctx) };
		case "address": return { wizard: await runAddress(ctx) };
		case "name": return { wizard: await runName(ctx) };
		case "database": return { wizard: await runDatabase(ctx) };
		case "migrations": return { wizard: await runMigrations(ctx) };
		case "upload": return runUpload(ctx);
		case "verify": return { wizard: await runVerify(ctx) };
		default: return { wizard: await wizardNow(ctx) };
	}
}

function apiOf(ctx: StepCtx) {
	return { fetchImpl: ctx.fetchImpl, token: ctx.token, fetchMs: ctx.fetchMs };
}

async function runAccount(ctx: StepCtx): Promise<InboxWizard> {
	const accounts = await listAccounts(apiOf(ctx));
	if (!Array.isArray(accounts)) {
		logFailure("account", accounts);
		return remember(ctx, { step: "account", state: "fail", text: "Cloudflare stops while reading your accounts.", cloudflare: describeCfFailure(accounts) });
	}
	if (!accounts.length) {
		return remember(ctx, { step: "account", state: "fail", text: "Cloudflare returns no account for this user.", cloudflare: "" });
	}
	const selected = pickAccount(accounts, ctx.fields.account);
	if (!selected) {
		return remember(ctx, {
			step: "account",
			state: "fixable",
			text: "Choose the Cloudflare account to use.",
			cloudflare: "",
			accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
		});
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { cfAccountId: selected.id, wizardStep: "account", stepError: null, status: "pending" });
	return wizardNow(ctx);
}

function pickAccount(accounts: CfAccount[], requested: string): CfAccount | null {
	if (requested) return accounts.find((account) => account.id === requested) ?? null;
	return accounts.length === 1 ? accounts[0]! : null;
}

async function runAddress(ctx: StepCtx): Promise<InboxWizard> {
	const accountId = ctx.row.cf_account_id;
	if (!accountId) return remember(ctx, { step: "address", state: "fail", text: "Choose the Cloudflare account to use.", cloudflare: "" });
	if (ctx.host === "zone") return runZoneAddress(ctx, accountId);
	return runWorkersAddress(ctx, accountId);
}

async function runWorkersAddress(ctx: StepCtx, accountId: string): Promise<InboxWizard> {
	const current = await workersDevSubdomain({ ...apiOf(ctx), accountId });
	const missing = typeof current !== "string" && subdomainMissing(current);
	if (typeof current !== "string" && !missing) {
		logFailure("subdomain", current);
		return remember(ctx, { step: "address", state: "fail", text: "Cloudflare stops while checking the workers.dev name.", cloudflare: describeCfFailure(current) });
	}
	if (typeof current === "string" && current) {
		await patchInbox(ctx.db, ctx.userId, ctx.now, { workersSubdomain: current, wizardStep: "address", stepError: null, status: "pending", cfAccountId: accountId });
		return wizardNow(ctx);
	}
	if (!ctx.fields.subdomain) {
		const cloudflare = typeof current !== "string" ? describeCfFailure(current) : "";
		return remember(ctx, { step: "address", state: "fixable", text: "This Cloudflare account has no workers.dev name yet. Type one below.", cloudflare });
	}
	if (!LABEL_RE.test(ctx.fields.subdomain)) {
		return remember(ctx, { step: "address", state: "fixable", text: "Use a short name: lowercase letters, numbers, and hyphens.", cloudflare: "" });
	}
	const registered = await registerWorkersDevSubdomain({ ...apiOf(ctx), accountId, subdomain: ctx.fields.subdomain });
	if (registered !== true) {
		if (registered.status === 409) {
			return remember(ctx, { step: "address", state: "fixable", text: "That workers.dev name is taken. Type another.", cloudflare: describeCfFailure(registered) });
		}
		logFailure("subdomain-create", registered);
		return remember(ctx, { step: "address", state: "fail", text: "Cloudflare stops while creating the workers.dev name.", cloudflare: describeCfFailure(registered) });
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { workersSubdomain: ctx.fields.subdomain, wizardStep: "address", stepError: null, status: "pending", cfAccountId: accountId });
	return wizardNow(ctx);
}

async function runZoneAddress(ctx: StepCtx, accountId: string): Promise<InboxWizard> {
	if (!HOST_RE.test(ctx.fields.hostname) || ctx.fields.hostname.endsWith(".workers.dev")) {
		return remember(ctx, { step: "address", state: "fixable", text: "Use a web address on a domain already in this Cloudflare account, such as agent.example.com.", cloudflare: "" });
	}
	const zones = await listZones({ ...apiOf(ctx), accountId });
	if (!Array.isArray(zones)) {
		logFailure("zones", zones);
		return remember(ctx, { step: "address", state: "fail", text: "Cloudflare stops while reading domains in this account.", cloudflare: describeCfFailure(zones) });
	}
	const zone = zoneForHostname(ctx.fields.hostname, zones);
	if (!zone) {
		return remember(ctx, {
			step: "address",
			state: "fixable",
			text: "That address is not on a domain in this Cloudflare account.",
			cloudflare: "",
			zones: activeZoneNames(zones),
		});
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { hostname: ctx.fields.hostname, wizardStep: "address", stepError: null, status: "pending", cfAccountId: accountId });
	return wizardNow(ctx);
}

async function runName(ctx: StepCtx): Promise<InboxWizard> {
	const accountId = ctx.row.cf_account_id;
	if (!accountId) return remember(ctx, { step: "name", state: "fail", text: "Choose the Cloudflare account to use.", cloudflare: "" });
	const workerName = ctx.host === "workers" ? ctx.fields.name : workerNameFromHostname(ctx.fields.hostname || ctx.row.hostname || "");
	if (!workerName || !LABEL_RE.test(workerName)) {
		if (ctx.host === "zone") {
			await patchInbox(ctx.db, ctx.userId, ctx.now, {
				wizardStep: "account",
				stepError: noteJson(noted(ctx, { step: "address", state: "fixable", text: "Use a web address on a domain already in this Cloudflare account, such as agent.example.com.", cloudflare: "" })),
				status: "pending",
			});
			return wizardNow(ctx);
		}
		return remember(ctx, { step: "name", state: "fixable", text: "Use a short name: lowercase letters, numbers, and hyphens.", cloudflare: "" });
	}
	const found = await workerProvisionTag({ ...apiOf(ctx), accountId, name: workerName });
	if (found && typeof found === "object") {
		logFailure("worker", found);
		return remember(ctx, { step: "name", state: "fail", text: "Cloudflare stops while checking the name.", cloudflare: describeCfFailure(found) });
	}
	if (typeof found === "string" && !sameTag(ctx.row.script_tag ?? "", found)) {
		return remember(ctx, { step: "name", state: "fixable", text: "A Worker with that name is already in this Cloudflare account. Choose another name.", cloudflare: "" });
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { workerName, wizardStep: "name", stepError: null, status: "pending", cfAccountId: accountId });
	return wizardNow(ctx);
}

async function reopenName(ctx: StepCtx, text: string, cloudflare: string): Promise<InboxWizard> {
	await patchInbox(ctx.db, ctx.userId, ctx.now, {
		wizardStep: "address",
		workerName: "",
		stepError: noteJson(noted(ctx, { step: "name", state: "fixable", text, cloudflare, reopenName: true })),
		status: "pending",
	});
	return wizardNow(ctx);
}

async function runDatabase(ctx: StepCtx): Promise<InboxWizard> {
	const accountId = ctx.row.cf_account_id;
	const workerName = ctx.row.worker_name;
	if (!accountId || !workerName) return remember(ctx, { step: "database", state: "fail", text: "Choose a name before creating the database.", cloudflare: "" });
	if (ctx.row.d1_id) {
		await patchInbox(ctx.db, ctx.userId, ctx.now, { wizardStep: "database", stepError: null, status: "pending" });
		return wizardNow(ctx);
	}
	const found = await findD1({ ...apiOf(ctx), accountId, name: workerName });
	if (found && typeof found === "object" && "ok" in found) {
		return failOrWait(ctx, "database", found, "Cloudflare stops while looking for the database.", "d1-list");
	}
	if (found && typeof found === "object" && "uuid" in found) {
		return reopenName(ctx, "A database with that name is already in this Cloudflare account. Choose another name.", "");
	}
	const created = await createD1({ ...apiOf(ctx), accountId, name: workerName });
	if (!("uuid" in created)) {
		if (created.status === 409) return reopenName(ctx, "A database with that name is already in this Cloudflare account. Choose another name.", describeCfFailure(created));
		return failOrWait(ctx, "database", created, "Cloudflare stops while creating the database.", "d1-create");
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, {
		d1Id: created.uuid,
		scriptTag: ctx.row.script_tag || newScriptTag(),
		wizardStep: "database",
		stepError: null,
		status: "pending",
		cfAccountId: accountId,
		workerName,
	});
	return wizardNow(ctx);
}

async function runMigrations(ctx: StepCtx): Promise<InboxWizard> {
	const accountId = ctx.row.cf_account_id;
	const databaseId = ctx.row.d1_id ?? "";
	if (!accountId || !databaseId) return remember(ctx, { step: "migrations", state: "fail", text: "This dashboard cannot set up the database right now.", cloudflare: "" });
	if (!ctx.migrations.length) return remember(ctx, { step: "migrations", state: "fail", text: "This dashboard cannot set up the database right now.", cloudflare: "" });
	const migrated = await applyMigrations({ ...apiOf(ctx), accountId, databaseId, migrations: ctx.migrations });
	if (migrated !== true) {
		return failOrWait(ctx, "migrations", migrated, "Cloudflare stops while applying the database setup.", "migrations");
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { wizardStep: "migrations", stepError: null, status: "pending" });
	return wizardNow(ctx);
}

async function guardScript(ctx: StepCtx, accountId: string, name: string): Promise<true | InboxWizard> {
	const found = await workerProvisionTag({ ...apiOf(ctx), accountId, name });
	if (found === null) return true;
	if (typeof found !== "string") {
		return failOrWait(ctx, "upload", found, "Cloudflare stops while checking the name.", "worker");
	}
	if (sameTag(ctx.row.script_tag ?? "", found)) return true;
	return remember(ctx, { step: "upload", state: "fail", text: "A Worker with that name is already in this Cloudflare account. This page does not replace it.", cloudflare: "" });
}

async function runUpload(ctx: StepCtx): Promise<{ wizard: InboxWizard; ownerToken?: string }> {
	const accountId = ctx.row.cf_account_id;
	const workerName = ctx.row.worker_name;
	const databaseId = ctx.row.d1_id ?? "";
	if (!accountId || !workerName || !databaseId) {
		return { wizard: await remember(ctx, { step: "upload", state: "fail", text: "This dashboard cannot upload the inbox right now.", cloudflare: "" }) };
	}
	if (ctx.host === "workers" && !ctx.row.workers_subdomain) {
		await patchInbox(ctx.db, ctx.userId, ctx.now, {
			wizardStep: "account",
			stepError: noteJson(noted(ctx, { step: "address", state: "fixable", text: "This Cloudflare account has no workers.dev name yet. Type one below.", cloudflare: "" })),
			status: "pending",
		});
		return { wizard: await wizardNow(ctx) };
	}
	if (ctx.host === "zone" && !ctx.row.hostname) {
		await patchInbox(ctx.db, ctx.userId, ctx.now, {
			wizardStep: "account",
			stepError: noteJson(noted(ctx, { step: "address", state: "fixable", text: "Type the web address for this inbox.", cloudflare: "" })),
			status: "pending",
		});
		return { wizard: await wizardNow(ctx) };
	}
	const guard = await guardScript(ctx, accountId, workerName);
	if (guard !== true) return { wizard: guard };
	if (!ctx.script.trim() || ctx.script.length > 5_000_000) {
		return { wizard: await remember(ctx, { step: "upload", state: "fail", text: "This dashboard cannot upload the inbox right now.", cloudflare: "" }) };
	}
	const publicUrl = plannedUrl(ctx.row, ctx.host);
	if (!publicUrl) return { wizard: await remember(ctx, { step: "upload", state: "fail", text: "This dashboard cannot upload the inbox right now.", cloudflare: "" }) };
	const scriptTag = ctx.row.script_tag || newScriptTag();
	const ownerToken = newOwnerToken();
	const uploaded = await uploadWorker({
		...apiOf(ctx),
		fetchMs: Math.max(ctx.fetchMs, 20_000),
		accountId,
		name: workerName,
		script: ctx.script,
		metadata: scriptMetadata({ d1Id: databaseId, publicUrl, workerName, ownerToken, scriptTag }),
	});
	if (uploaded !== true) {
		return { wizard: await failOrWait(ctx, "upload", uploaded, "Cloudflare stops while uploading the inbox.", "upload") };
	}
	if (ctx.host === "workers") {
		const enabled = await setWorkersDevEnabled({ ...apiOf(ctx), accountId, name: workerName, enabled: true });
		if (enabled !== true) {
			return { wizard: await failOrWait(ctx, "upload", enabled, "Cloudflare stops while turning on the free address.", "workers-dev") };
		}
	} else {
		const zones = await listZones({ ...apiOf(ctx), accountId });
		if (!Array.isArray(zones)) {
			return { wizard: await failOrWait(ctx, "upload", zones, "Cloudflare stops while reading domains in this account.", "zones") };
		}
		const zone = zoneForHostname(ctx.row.hostname ?? "", zones);
		if (!zone) {
			return { wizard: await remember(ctx, { step: "upload", state: "fail", text: "That address is not on a domain in this Cloudflare account.", cloudflare: "" }) };
		}
		const attached = await attachHostname({ ...apiOf(ctx), accountId, workerName, hostname: ctx.row.hostname ?? "", zoneId: zone.id });
		if (attached !== true) {
			return { wizard: await failOrWait(ctx, "upload", attached, "Cloudflare stops while attaching the address.", "hostname") };
		}
		const disabled = await setWorkersDevEnabled({ ...apiOf(ctx), accountId, name: workerName, enabled: false });
		if (disabled !== true && disabled.status !== 404) logFailure("workers-dev-off", disabled);
	}
	const ownerTokenHash = await hashOwnerToken(ownerToken);
	await patchInbox(ctx.db, ctx.userId, ctx.now, {
		wizardStep: "upload",
		ownerTokenHash,
		scriptTag,
		status: "pending",
		stepError: null,
		cfAccountId: accountId,
	});
	const wizard = await wizardNow(ctx);
	wizard.ownerToken = ownerToken;
	return { wizard, ownerToken };
}

async function runVerify(ctx: StepCtx): Promise<InboxWizard> {
	const url = plannedUrl(ctx.row, ctx.host);
	if (!url) return remember(ctx, { step: "verify", state: "fail", text: "This dashboard cannot check the inbox right now.", cloudflare: "" });
	const probe = await probeInbox(ctx.fetchImpl, url, ctx.fetchMs);
	if (!probe.ok) {
		logFailure("verify", probe.failure);
		const http = probe.failure.status ? ` HTTP ${probe.failure.status}.` : "";
		const cloudflare = probe.failure.thrown ? describeCfFailure(probe.failure) : "";
		return remember(ctx, { step: "verify", state: "fail", text: `The inbox does not answer yet.${http} A new address can take a few minutes.`, cloudflare });
	}
	await patchInbox(ctx.db, ctx.userId, ctx.now, { status: "ready", wizardStep: "verify", publicUrl: url, stepError: null });
	return wizardNow(ctx);
}
