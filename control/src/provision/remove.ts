// Deletes only the Cloudflare resources this setup created, then drops the dashboard row.
// The Worker is deleted only when its provision tag still matches. A resource the user
// already deleted is treated as done.

import { refreshCloudflareGrant } from "../auth/cloudflare-grant.ts";
import type { Sql } from "../auth/invites.ts";
import { deleteCloudflareInbox, readCloudflareInboxById, type InboxRow } from "./inbox-row.ts";
import {
	deleteD1,
	deleteWorker,
	deleteWorkersDomain,
	describeCfFailure,
	getD1,
	listWorkersDomains,
	workerProvisionTag,
	type CfFailure,
} from "./cloudflare-api.ts";

export type RemovalId = "address" | "worker" | "database" | "dashboard";

export interface RemovalItem {
	id: Exclude<RemovalId, "dashboard">;
	title: string;
	detail: string;
}

export interface RemovalStep {
	id: RemovalId;
	title: string;
	state: "pass" | "fail" | "pending";
	text: string;
	cloudflare: string;
}

interface RemovalNote {
	removing: true;
	passed: RemovalId[];
	texts?: Partial<Record<RemovalId, string>>;
	failed?: RemovalId;
	text?: string;
	cloudflare?: string;
}

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

function readNote(raw: string | null): RemovalNote | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as RemovalNote;
		if (!parsed || parsed.removing !== true || !Array.isArray(parsed.passed)) return null;
		return parsed;
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

async function save(db: Sql, row: InboxRow, note: RemovalNote, now: number): Promise<void> {
	await db.prepare(
		`UPDATE cloudflare_inbox SET status = 'removing', step_error = ?, updated_at = ? WHERE id = ? AND "userId" = ?`,
	).bind(JSON.stringify(note), new Date(now).toISOString(), row.id, row.userId).run();
}

function failureText(failure: CfFailure): { text: string; cloudflare: string } {
	return { text: "Cloudflare did not remove this. Try again.", cloudflare: describeCfFailure(failure) };
}

async function removeAddress(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<{ ok: true; text: string } | { ok: false; text: string; cloudflare: string }> {
	const domains = await listWorkersDomains(input);
	if (!Array.isArray(domains)) return { ok: false, ...failureText(domains) };
	const hostname = (row.hostname ?? "").toLowerCase();
	const found = domains.find((domain) => domain.hostname === hostname);
	if (!found) return { ok: true, text: "Already gone." };
	if (found.service !== row.worker_name) return { ok: true, text: "This address is not on the Worker this setup created, so it stays." };
	const removed = await deleteWorkersDomain({ ...input, domainId: found.id });
	if (removed !== true) return { ok: false, ...failureText(removed) };
	return { ok: true, text: `${hostname} is removed.` };
}

async function removeWorker(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<{ ok: true; text: string } | { ok: false; text: string; cloudflare: string }> {
	const tag = await workerProvisionTag({ ...input, name: row.worker_name });
	if (tag && typeof tag === "object") return { ok: false, ...failureText(tag) };
	if (tag === null) return { ok: true, text: "Already gone." };
	if (!row.script_tag || tag !== row.script_tag) return { ok: true, text: "This Worker was not created by this setup, so it stays." };
	const removed = await deleteWorker({ ...input, name: row.worker_name });
	if (removed !== true) return { ok: false, ...failureText(removed) };
	return { ok: true, text: `${row.worker_name} is removed.` };
}

async function removeDatabase(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }, row: InboxRow): Promise<{ ok: true; text: string } | { ok: false; text: string; cloudflare: string }> {
	const databaseId = row.d1_id ?? "";
	const found = await getD1({ ...input, databaseId });
	if (found && "ok" in found) return { ok: false, ...failureText(found) };
	if (!found) return { ok: true, text: "Already gone." };
	const expected = row.d1_name || row.worker_name;
	if (found.name !== expected) return { ok: true, text: "This database was not created by this setup, so it stays." };
	const removed = await deleteD1({ ...input, databaseId });
	if (removed !== true) return { ok: false, ...failureText(removed) };
	return { ok: true, text: `${expected} is removed.` };
}

/**
 * Runs the next removal step. A pass is stored. A failure stays on that step for Try again.
 * The dashboard row is removed only after the Cloudflare steps have passed.
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
}): Promise<{ finished: boolean; row: InboxRow | null }> {
	const now = input.now ?? Date.now();
	const row = await readCloudflareInboxById(input.database, input.userId, input.inboxId);
	if (!row) return { finished: true, row: null };
	const note = readNote(row.step_error) ?? { removing: true as const, passed: [] };
	const passed = new Set(note.passed);
	const order: RemovalId[] = [...removalItems(row).map((item) => item.id), "dashboard"];
	const step = order.find((id) => !passed.has(id));
	if (!step || step === "dashboard") {
		await deleteCloudflareInbox(input.database, input.userId, row.id);
		return { finished: true, row: null };
	}
	const refreshed = await refreshCloudflareGrant({
		database: input.database,
		secret: input.secret,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		userId: input.userId,
		fetchMs: Math.min(input.fetchMs ?? 10_000, 5_000),
		now,
	});
	if (!refreshed.ok) {
		await save(input.database, row, { removing: true, passed: [...passed], failed: step, text: "The saved Cloudflare permission expired. Connect Cloudflare again, then try again.", cloudflare: "" }, now);
		const updated = await readCloudflareInboxById(input.database, input.userId, row.id);
		return { finished: false, row: updated };
	}
	const api = { fetchImpl: input.fetchImpl ?? fetch, token: refreshed.accessToken, fetchMs: input.fetchMs ?? 10_000, accountId: row.cf_account_id };
	const result = step === "address"
		? await removeAddress(api, row)
		: step === "worker"
			? await removeWorker(api, row)
			: await removeDatabase(api, row);
	if (!result.ok) {
		await save(input.database, row, { removing: true, passed: [...passed], failed: step, text: result.text, cloudflare: result.cloudflare }, now);
		return { finished: false, row: await readCloudflareInboxById(input.database, input.userId, row.id) };
	}
	passed.add(step);
	const texts = { ...(note.texts ?? {}), [step]: result.text };
	const next = order.find((id) => !passed.has(id));
	if (!next || next === "dashboard") {
		await deleteCloudflareInbox(input.database, input.userId, row.id);
		return { finished: true, row: null };
	}
	await save(input.database, row, { removing: true, passed: [...passed], texts, text: result.text, cloudflare: "" }, now);
	return { finished: false, row: await readCloudflareInboxById(input.database, input.userId, row.id) };
}
