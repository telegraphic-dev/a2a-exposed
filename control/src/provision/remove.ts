// Deletes only the Cloudflare resources this setup created, then drops the dashboard row.
// The Worker is deleted only when its provision tag still matches. A resource the user
// already deleted is treated as done. Cloudflare codes 10000 and 7403 on the Worker
// or the database wait for the permission to apply.

import type { Sql } from "../core/sql.ts";
import { openCloudflareRefresh, refreshCloudflareGrant, sealCloudflareRefresh, type RefreshResult } from "./grant.ts";
import { deleteCloudflareInbox, readCloudflareInboxById, type InboxRow } from "./inbox-row.ts";
import {
	deleteD1,
	deleteWorker,
	deleteWorkersDomain,
	describeCfFailure,
	getD1,
	listWorkersDomains,
	permissionNotReady,
	workerProvisionTag,
	type CfFailure,
} from "./cloudflare-api.ts";
import { PERMISSION_WAIT } from "./permission-wait.ts";

export type RemovalId = "address" | "worker" | "database" | "dashboard";

/** Pauses between Worker and database removal tries. The pauses add up to 90 seconds. */
export const REMOVAL_PERMISSION_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

/** How long after consent a 10000 or 7403 on removal stays a wait. */
export const REMOVAL_PERMISSION_WINDOW_MS = 90_000;

export type RemovalLock = "claimed" | "busy" | "skipped" | "hook";

export interface RemovalEvent {
	event: "removal_step" | "removal_step_failed";
	step: RemovalId;
	status: number;
	code: number | null;
	secondsSinceConsent: number | null;
	rotations: number;
	lock: RemovalLock;
}

export interface RemovalItem {
	id: Exclude<RemovalId, "dashboard">;
	title: string;
	detail: string;
}

export interface RemovalStep {
	id: RemovalId;
	title: string;
	state: "pass" | "fail" | "pending" | "wait";
	text: string;
	cloudflare: string;
}

export interface RemovalStepResult {
	finished: boolean;
	row: InboxRow | null;
	status: "finished" | "pass" | "waiting" | "fail";
	retryAt?: number;
}

/** Same inputs as `refreshCloudflareGrant`, so a caller can refresh on a cache miss. */
export interface RefreshAccessInput {
	database: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	fetchMs: number;
	now: number;
	fetchImpl: typeof fetch;
}

export type RefreshAccessResult = RefreshResult & {
	/** True when this call rotated the refresh token. A cache hit sets false. */
	rotated?: boolean;
	lock?: RemovalLock;
};

interface RemovalNote {
	removing: true;
	passed: RemovalId[];
	texts?: Partial<Record<RemovalId, string>>;
	failed?: RemovalId;
	text?: string;
	cloudflare?: string;
	state?: "fail" | "wait";
	permissionTries?: number;
	retryAt?: number;
	consentAt?: number;
	waitStartedAt?: number;
	rotations?: number;
}

interface HeldAccess {
	inbox: string;
	step: RemovalId;
	until: number;
	enc: string;
}

type StepOutcome =
	| { ok: true; text: string }
	| { ok: false; text: string; cloudflare: string; failure: CfFailure };

function uploaded(row: InboxRow): boolean {
	return row.status === "ready" || row.wizard_step === "upload" || row.wizard_step === "verify" || Boolean(row.public_url);
}

/** What this setup created, in the order removal runs. */
export function removalItems(row: InboxRow): RemovalItem[] {
	const items: RemovalItem[] = [];
	if (row.host === "zone" && row.hostname && uploaded(row)) {
		items.push({ id: "address", title: "Address", detail: row.hostname });
	}
	if (row.worker_name && uploaded(row)) {
		items.push({ id: "worker", title: "Worker", detail: row.worker_name });
	}
	if (row.d1_id && (row.d1_name || row.worker_name)) {
		items.push({ id: "database", title: "Database", detail: row.d1_name || row.worker_name });
	}
	return items;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNote(raw: string | null): RemovalNote | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as RemovalNote;
		if (!parsed || parsed.removing !== true || !Array.isArray(parsed.passed)) return null;
		const state = parsed.state === "wait" || parsed.state === "fail" ? parsed.state : undefined;
		const permissionTries = Number.isInteger(parsed.permissionTries) && (parsed.permissionTries ?? 0) >= 1 ? parsed.permissionTries : undefined;
		const retryAt = finite(parsed.retryAt);
		const consentAt = finite(parsed.consentAt);
		const waitStartedAt = finite(parsed.waitStartedAt);
		const rotations = Number.isInteger(parsed.rotations) && (parsed.rotations ?? 0) >= 0 ? parsed.rotations : undefined;
		return {
			...parsed,
			...(state ? { state } : {}),
			...(permissionTries ? { permissionTries } : {}),
			...(retryAt != null ? { retryAt } : {}),
			...(consentAt != null ? { consentAt } : {}),
			...(waitStartedAt != null ? { waitStartedAt } : {}),
			...(rotations != null ? { rotations } : {}),
		};
	} catch {
		return null;
	}
}

export function removalSteps(row: InboxRow): RemovalStep[] {
	const note = readNote(row.step_error);
	const passed = new Set(note?.passed ?? []);
	const items = removalItems(row);
	const steps: RemovalStep[] = items.map((item) => {
		if (passed.has(item.id)) return { id: item.id, title: item.title, state: "pass", text: note?.texts?.[item.id] || `${item.detail} is removed.`, cloudflare: "" };
		if (note?.failed === item.id && note.state === "wait") {
			return { id: item.id, title: item.title, state: "wait", text: note.text || PERMISSION_WAIT, cloudflare: "" };
		}
		if (note?.failed === item.id) {
			return { id: item.id, title: item.title, state: "fail", text: note.text || "Cloudflare did not remove this.", cloudflare: note.cloudflare || "" };
		}
		return { id: item.id, title: item.title, state: "pending", text: item.detail, cloudflare: "" };
	});
	const resourcesDone = items.every((item) => passed.has(item.id));
	steps.push({
		id: "dashboard",
		title: "Dashboard",
		state: passed.has("dashboard") ? "pass" : "pending",
		text: resourcesDone ? "Remove this agent from the dashboard." : "This stays until the Cloudflare resources are removed.",
		cloudflare: "",
	});
	return steps;
}

/** True when a waiting removal step is ready to try again. */
export function removalRetryDue(row: InboxRow | null, now = Date.now()): boolean {
	if (!row || row.status === "ready") return false;
	const note = readNote(row.step_error);
	if (!note || note.state !== "wait") return false;
	if (typeof note.retryAt !== "number") return true;
	return now >= note.retryAt;
}

async function save(db: Sql, row: InboxRow, note: RemovalNote, now: number): Promise<void> {
	await db.prepare(
		`UPDATE cloudflare_inbox SET status = 'removing', step_error = ?, updated_at = ? WHERE id = ? AND "userId" = ?`,
	).bind(JSON.stringify(note), new Date(now).toISOString(), row.id, row.userId).run();
}

function failureText(failure: CfFailure): StepOutcome {
	return { ok: false, text: "Cloudflare did not remove this. Try again.", cloudflare: describeCfFailure(failure), failure };
}

function missingColumn(error: unknown): boolean {
	return error instanceof Error && /no such column/i.test(error.message);
}

async function readHeldAccess(db: Sql, userId: string): Promise<HeldAccess | null> {
	try {
		const row = await db.prepare(
			`SELECT removal_access FROM cloudflare_grant WHERE "userId" = ?`,
		).bind(userId).first<{ removal_access: string | null }>();
		if (!row?.removal_access) return null;
		const parsed = JSON.parse(row.removal_access) as HeldAccess;
		if (!parsed || typeof parsed.enc !== "string" || typeof parsed.inbox !== "string") return null;
		if (parsed.step !== "worker" && parsed.step !== "database" && parsed.step !== "address") return null;
		if (typeof parsed.until !== "number" || !Number.isFinite(parsed.until)) return null;
		return parsed;
	} catch (error) {
		if (missingColumn(error)) return null;
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

async function writeHeldAccess(db: Sql, userId: string, value: string | null): Promise<void> {
	try {
		await db.prepare(
			`UPDATE cloudflare_grant SET removal_access = ? WHERE "userId" = ?`,
		).bind(value, userId).run();
	} catch (error) {
		if (missingColumn(error)) return;
		throw error;
	}
}

async function removeAddress(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<StepOutcome> {
	const domains = await listWorkersDomains(input);
	if (!Array.isArray(domains)) return failureText(domains);
	const hostname = (row.hostname ?? "").toLowerCase();
	const found = domains.find((domain) => domain.hostname === hostname);
	if (!found) return { ok: true, text: "Already gone." };
	if (found.service !== row.worker_name) return { ok: true, text: "This address is not on the Worker this setup created, so it stays." };
	const removed = await deleteWorkersDomain({ ...input, domainId: found.id });
	if (removed !== true) return failureText(removed);
	return { ok: true, text: `${hostname} is removed.` };
}

async function removeWorker(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<StepOutcome> {
	const tag = await workerProvisionTag({ ...input, name: row.worker_name });
	if (tag && typeof tag === "object") return failureText(tag);
	if (tag === null) return { ok: true, text: "Already gone." };
	if (!row.script_tag || tag !== row.script_tag) return { ok: true, text: "This Worker was not created by this setup, so it stays." };
	const removed = await deleteWorker({ ...input, name: row.worker_name });
	if (removed !== true) return failureText(removed);
	return { ok: true, text: `${row.worker_name} is removed.` };
}

async function removeDatabase(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<StepOutcome> {
	const databaseId = row.d1_id ?? "";
	const found = await getD1({ ...input, databaseId });
	if (found && "ok" in found) return failureText(found);
	if (!found) return { ok: true, text: "Already gone." };
	const expected = row.d1_name || row.worker_name;
	if (found.name !== expected) return { ok: true, text: "This database was not created by this setup, so it stays." };
	const removed = await deleteD1({ ...input, databaseId });
	if (removed !== true) return failureText(removed);
	return { ok: true, text: `${expected} is removed.` };
}

function delaysOf(value: number[] | undefined): number[] {
	if (!value || value.length === 0) return REMOVAL_PERMISSION_DELAYS_MS;
	const clean = value.filter((item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 120_000);
	return clean.length ? clean : REMOVAL_PERMISSION_DELAYS_MS;
}

function windowOf(value: number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 * 60_000) return value;
	return REMOVAL_PERMISSION_WINDOW_MS;
}

function consentAnchor(input: { consentedAt?: number; secondsSinceConsent?: number }, note: RemovalNote | null, now: number): number | null {
	if (typeof input.secondsSinceConsent === "number" && Number.isFinite(input.secondsSinceConsent)) {
		return now - Math.max(0, input.secondsSinceConsent) * 1000;
	}
	if (typeof input.consentedAt === "number" && Number.isFinite(input.consentedAt)) return input.consentedAt;
	if (typeof note?.consentAt === "number") return note.consentAt;
	return null;
}

function secondsSince(anchor: number | null, now: number): number | null {
	if (anchor == null) return null;
	return Math.max(0, Math.floor((now - anchor) / 1000));
}

function emit(onEvent: ((event: RemovalEvent) => void) | undefined, event: RemovalEvent): void {
	if (!onEvent) return;
	const line: RemovalEvent = {
		event: event.event,
		step: event.step,
		status: event.status,
		code: event.code,
		secondsSinceConsent: event.secondsSinceConsent,
		rotations: event.rotations,
		lock: event.lock,
	};
	try {
		onEvent(line);
	} catch {
		// A logger error leaves the removal result in place.
	}
}

function lockForRefreshError(error: string): RemovalLock {
	if (error === "busy") return "busy";
	if (error === "no_grant" || error === "no_refresh") return "skipped";
	return "claimed";
}

function waitsForPermission(step: RemovalId, failure: CfFailure, now: number, deadline: number, tries: number, delays: number[]): number | null {
	if (step !== "worker" && step !== "database") return null;
	if (!permissionNotReady(failure)) return null;
	if (!(now < deadline)) return null;
	if (tries > delays.length) return null;
	const delay = delays[tries - 1] ?? 0;
	const retryAt = now + delay;
	if (delay > 0 && retryAt > deadline) return null;
	return retryAt;
}

interface ObtainInput {
	database: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	fetchMs: number;
	now: number;
	fetchImpl: typeof fetch;
	refreshAccess?: (input: RefreshAccessInput) => Promise<RefreshAccessResult>;
	accessToken?: string;
}

type Obtained =
	| { ok: true; accessToken: string; rotations: number; lock: RemovalLock }
	| { ok: false; error: string; rotations: number; lock: RemovalLock };

async function obtainAccess(input: ObtainInput, row: InboxRow, step: RemovalId, rotationsBefore: number, continuing: boolean, windowMs: number): Promise<Obtained> {
	if (input.refreshAccess) {
		await writeHeldAccess(input.database, input.userId, null);
		const refreshed = await input.refreshAccess({
			database: input.database,
			secret: input.secret,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			userId: input.userId,
			fetchMs: input.fetchMs,
			now: input.now,
			fetchImpl: input.fetchImpl,
		});
		if (!refreshed.ok) {
			return { ok: false, error: refreshed.error, rotations: rotationsBefore, lock: refreshed.lock ?? (refreshed.error === "busy" ? "busy" : "hook") };
		}
		const rotated = refreshed.rotated !== false;
		return {
			ok: true,
			accessToken: refreshed.accessToken,
			rotations: rotationsBefore + (rotated ? 1 : 0),
			lock: refreshed.lock ?? "hook",
		};
	}
	if (typeof input.accessToken === "string" && input.accessToken) {
		await writeHeldAccess(input.database, input.userId, null);
		return { ok: true, accessToken: input.accessToken, rotations: rotationsBefore, lock: "skipped" };
	}
	if (continuing) {
		const held = await readHeldAccess(input.database, input.userId);
		if (held && held.inbox === row.id && held.step === step && held.until >= input.now) {
			const token = await openCloudflareRefresh(input.secret, input.userId, held.enc);
			if (token) return { ok: true, accessToken: token, rotations: rotationsBefore, lock: "skipped" };
		}
	}
	const refreshed = await refreshCloudflareGrant({
		database: input.database,
		secret: input.secret,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		userId: input.userId,
		fetchMs: Math.min(input.fetchMs, 5_000),
		now: input.now,
		fetchImpl: input.fetchImpl,
	});
	if (!refreshed.ok) {
		return { ok: false, error: refreshed.error, rotations: rotationsBefore, lock: lockForRefreshError(refreshed.error) };
	}
	const sealed = await sealCloudflareRefresh(input.secret, input.userId, refreshed.accessToken);
	if (sealed) {
		const held: HeldAccess = { inbox: row.id, step, until: input.now + windowMs, enc: sealed };
		await writeHeldAccess(input.database, input.userId, JSON.stringify(held));
	}
	return { ok: true, accessToken: refreshed.accessToken, rotations: rotationsBefore + 1, lock: "claimed" };
}

/**
 * Runs the next removal step. A pass is stored. A failure stays on that step for Try again.
 * The dashboard row is removed only after the Cloudflare steps have passed.
 * Worker and database calls that hit Cloudflare code 10000 or 7403 return `waiting`
 * until 90 seconds after consent. Retries of that step reuse the access token.
 */
export async function runRemovalStep(input: {
	database: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	inboxId: string;
	fetchMs?: number;
	now?: number;
	fetchImpl?: typeof fetch;
	/** Milliseconds when the Cloudflare consent completed. */
	consentedAt?: number;
	/** Seconds from consent to this call. Used when `consentedAt` is omitted. */
	secondsSinceConsent?: number;
	/** Pauses after a permission error. The default pauses add up to 90 seconds. */
	permissionDelaysMs?: number[];
	/** Milliseconds after consent that a permission error stays a wait. Default 90 seconds. */
	permissionWindowMs?: number;
	/**
	 * Supplies the access token. When set, this step skips `refreshCloudflareGrant`.
	 * A cache hit reports `rotated: false`.
	 */
	refreshAccess?: (input: RefreshAccessInput) => Promise<RefreshAccessResult>;
	/** Access token the caller already holds. When set, this step skips the refresh. */
	accessToken?: string;
	onEvent?: (event: RemovalEvent) => void;
}): Promise<RemovalStepResult> {
	const now = input.now ?? Date.now();
	const row = await readCloudflareInboxById(input.database, input.userId, input.inboxId);
	if (!row) return { finished: true, row: null, status: "finished" };
	const note = readNote(row.step_error) ?? { removing: true as const, passed: [] };
	const passed = new Set(note.passed);
	const order: RemovalId[] = [...removalItems(row).map((item) => item.id), "dashboard"];
	const step = order.find((id) => !passed.has(id));
	if (!step || step === "dashboard") {
		await writeHeldAccess(input.database, input.userId, null);
		await deleteCloudflareInbox(input.database, input.userId, row.id);
		emit(input.onEvent, {
			event: "removal_step",
			step: "dashboard",
			status: 200,
			code: null,
			secondsSinceConsent: secondsSince(consentAnchor(input, note, now), now),
			rotations: 0,
			lock: "skipped",
		});
		return { finished: true, row: null, status: "finished" };
	}
	const continuing = note.state === "wait" && note.failed === step;
	if (continuing && typeof note.retryAt === "number" && now < note.retryAt) {
		return { finished: false, row, status: "waiting", retryAt: note.retryAt };
	}
	const windowMs = windowOf(input.permissionWindowMs);
	const delays = delaysOf(input.permissionDelaysMs);
	const anchor = consentAnchor(input, note, now);
	const started = continuing && typeof note.waitStartedAt === "number" ? note.waitStartedAt : now;
	const deadline = (anchor ?? started) + windowMs;
	const rotationsBefore = continuing ? (note.rotations ?? 0) : 0;
	const fetchImpl = input.fetchImpl ?? fetch;
	const obtained = await obtainAccess({
		database: input.database,
		secret: input.secret,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		userId: input.userId,
		fetchMs: input.fetchMs ?? 10_000,
		now,
		fetchImpl,
		refreshAccess: input.refreshAccess,
		accessToken: input.accessToken,
	}, row, step, rotationsBefore, continuing, windowMs);
	const since = secondsSince(anchor, now);
	if (!obtained.ok) {
		emit(input.onEvent, {
			event: "removal_step_failed",
			step,
			status: 0,
			code: null,
			secondsSinceConsent: since,
			rotations: obtained.rotations,
			lock: obtained.lock,
		});
		await writeHeldAccess(input.database, input.userId, null);
		await save(input.database, row, {
			removing: true,
			passed: [...passed],
			...(note.texts ? { texts: note.texts } : {}),
			failed: step,
			state: "fail",
			text: "The saved Cloudflare permission expired. Connect Cloudflare again, then try again.",
			cloudflare: "",
			...(anchor != null ? { consentAt: anchor } : {}),
		}, now);
		const updated = await readCloudflareInboxById(input.database, input.userId, row.id);
		return { finished: false, row: updated, status: "fail" };
	}
	const api = { fetchImpl, token: obtained.accessToken, fetchMs: input.fetchMs ?? 10_000, accountId: row.cf_account_id };
	const result = step === "address"
		? await removeAddress(api, row)
		: step === "worker"
			? await removeWorker(api, row)
			: await removeDatabase(api, row);
	if (!result.ok) {
		const tries = (continuing ? (note.permissionTries ?? 0) : 0) + 1;
		const retryAt = waitsForPermission(step, result.failure, now, deadline, tries, delays);
		if (retryAt != null) {
			emit(input.onEvent, {
				event: "removal_step",
				step,
				status: result.failure.status,
				code: result.failure.code,
				secondsSinceConsent: since,
				rotations: obtained.rotations,
				lock: obtained.lock,
			});
			await save(input.database, row, {
				removing: true,
				passed: [...passed],
				...(note.texts ? { texts: note.texts } : {}),
				failed: step,
				state: "wait",
				text: PERMISSION_WAIT,
				cloudflare: "",
				permissionTries: tries,
				retryAt,
				waitStartedAt: continuing && typeof note.waitStartedAt === "number" ? note.waitStartedAt : now,
				rotations: obtained.rotations,
				...(anchor != null ? { consentAt: anchor } : {}),
			}, now);
			return { finished: false, row: await readCloudflareInboxById(input.database, input.userId, row.id), status: "waiting", retryAt };
		}
		emit(input.onEvent, {
			event: "removal_step_failed",
			step,
			status: result.failure.status,
			code: result.failure.code,
			secondsSinceConsent: since,
			rotations: obtained.rotations,
			lock: obtained.lock,
		});
		await writeHeldAccess(input.database, input.userId, null);
		await save(input.database, row, {
			removing: true,
			passed: [...passed],
			...(note.texts ? { texts: note.texts } : {}),
			failed: step,
			state: "fail",
			text: result.text,
			cloudflare: result.cloudflare,
			...(anchor != null ? { consentAt: anchor } : {}),
		}, now);
		return { finished: false, row: await readCloudflareInboxById(input.database, input.userId, row.id), status: "fail" };
	}
	emit(input.onEvent, {
		event: "removal_step",
		step,
		status: 200,
		code: null,
		secondsSinceConsent: since,
		rotations: obtained.rotations,
		lock: obtained.lock,
	});
	await writeHeldAccess(input.database, input.userId, null);
	passed.add(step);
	const texts = { ...(note.texts ?? {}), [step]: result.text };
	const next = order.find((id) => !passed.has(id));
	if (!next || next === "dashboard") {
		await deleteCloudflareInbox(input.database, input.userId, row.id);
		emit(input.onEvent, {
			event: "removal_step",
			step: "dashboard",
			status: 200,
			code: null,
			secondsSinceConsent: since,
			rotations: 0,
			lock: "skipped",
		});
		return { finished: true, row: null, status: "finished" };
	}
	await save(input.database, row, { removing: true, passed: [...passed], texts, text: result.text, cloudflare: "" }, now);
	return { finished: false, row: await readCloudflareInboxById(input.database, input.userId, row.id), status: "pass" };
}
