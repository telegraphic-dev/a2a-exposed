// The inbox row the account page reads. The setup wizard lives in inbox.ts and is
// loaded only when that page runs, so this file stays in the main Worker bundle.

import type { Sql } from "../auth/invites.ts";

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
	script_tag: string | null;
	wizard_step: string | null;
	workers_subdomain: string | null;
	step_error: string | null;
	created_at: string;
	updated_at: string;
}

export async function hashOwnerToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readCloudflareInbox(db: Sql, userId: string): Promise<InboxRow | null> {
	if (!userId) return null;
	return db.prepare(
		`SELECT "userId" AS userId, cf_account_id, worker_name, d1_name, d1_id, public_url, owner_token_hash, host, hostname, status, script_tag,
		        wizard_step, workers_subdomain, step_error, created_at, updated_at
		 FROM cloudflare_inbox WHERE "userId" = ?`,
	).bind(userId).first<InboxRow>();
}
