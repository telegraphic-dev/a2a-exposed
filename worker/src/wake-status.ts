// Owner-only diagnostics. Never return serialized wake payloads, previews or credentials.
export type Attempt = { at: string; httpStatus: number | null; transport: string };

export function attemptView(raw: unknown): Attempt | null {
	try {
		const v = JSON.parse(String(raw));
		if (!v || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
		if (v.httpStatus !== null && (!Number.isInteger(v.httpStatus) || v.httpStatus < 100 || v.httpStatus > 599)) return null;
		if (v.transport !== "relay" && v.transport !== "webhook") return null;
		return { at: v.at, httpStatus: v.httpStatus, transport: v.transport };
	} catch { return null; }
}

export function pendingView(row: Record<string, any>) {
	let payload: any = {};
	try { payload = JSON.parse(row.pending_json); } catch { /* no payload text in diagnostics */ }
	const iso = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 8640000000000000 ? new Date(n).toISOString() : null;
	return { contextId: row.context_id, peer: row.peer, since: iso(row.pending_since_ms), dueAt: iso(row.due_ms),
		reason: payload?.attempts ? "retry" : payload?.busy ? "busy" : "debounce",
		attempts: Number.isSafeInteger(payload?.attempts) && payload.attempts > 0 ? payload.attempts : 0 };
}
