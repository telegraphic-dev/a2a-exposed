// The inbox rows the account page reads. The setup wizard lives in inbox.ts and is
// loaded only when that page runs, so this file stays in the main Worker bundle.

import type { Sql } from "../core/sql.ts";

export interface InboxRow {
	id: string;
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
	script_tag: string | null;
	wizard_step: string | null;
	workers_subdomain: string | null;
	step_error: string | null;
	zone_id: string | null;
	created_at: string;
	updated_at: string;
}

const COLUMNS = `id, "userId" AS userId, cf_account_id, worker_name, d1_name, d1_id, public_url, owner_token_hash, host, hostname, status, script_tag,
		        wizard_step, workers_subdomain, step_error, zone_id, created_at, updated_at`;

export async function hashOwnerToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listCloudflareInboxes(db: Sql, userId: string): Promise<InboxRow[]> {
	if (!userId) return [];
	const listed = await db.prepare(
		`SELECT ${COLUMNS} FROM cloudflare_inbox WHERE "userId" = ? ORDER BY created_at`,
	).bind(userId).all<InboxRow>();
	return listed.results;
}

export async function readInboxById(db: Sql, inboxId: string): Promise<InboxRow | null> {
	if (!inboxId) return null;
	return db.prepare(`SELECT ${COLUMNS} FROM cloudflare_inbox WHERE id = ?`).bind(inboxId).first<InboxRow>();
}

export async function readCloudflareInboxById(db: Sql, userId: string, inboxId: string): Promise<InboxRow | null> {
	if (!userId || !inboxId) return null;
	return db.prepare(
		`SELECT ${COLUMNS} FROM cloudflare_inbox WHERE id = ? AND "userId" = ?`,
	).bind(inboxId, userId).first<InboxRow>();
}

/**
 * The inbox a step should continue. An in-progress row wins. Otherwise the latest
 * finished one. A row being removed is left to its own page.
 */
export async function readCloudflareInbox(db: Sql, userId: string): Promise<InboxRow | null> {
	const rows = await listCloudflareInboxes(db, userId);
	const open = rows.find((row) => row.status === "pending" || row.status === "working");
	if (open) return open;
	const ready = rows.filter((row) => row.status === "ready");
	return ready.at(-1) ?? null;
}

export async function deleteCloudflareInbox(db: Sql, userId: string, inboxId: string): Promise<boolean> {
	if (!userId || !inboxId) return false;
	const result = await db.prepare(`DELETE FROM cloudflare_inbox WHERE id = ? AND "userId" = ?`).bind(inboxId, userId).run();
	return result.meta?.changes === 1;
}

/** Hostname shown in the agent list. A setup that has no address yet says so. */
export function cloudflareHostname(row: Pick<InboxRow, "public_url" | "host" | "hostname" | "worker_name" | "workers_subdomain">): string {
	if (row.public_url) {
		try {
			const url = new URL(row.public_url);
			if (url.protocol === "https:" && !url.username && !url.password && url.hostname) return url.hostname;
		} catch {
			// A stored address that is not a URL is not shown as a link label.
		}
	}
	if (row.host === "zone" && row.hostname) return row.hostname;
	if (row.worker_name && row.workers_subdomain) return `${row.worker_name}.${row.workers_subdomain}.workers.dev`;
	if (row.worker_name) return row.worker_name;
	return "Setting up";
}
