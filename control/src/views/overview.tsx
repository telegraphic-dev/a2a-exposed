const TASK_STATES = ["submitted", "working", "input-required", "completed", "failed", "rejected", "canceled"] as const;

const STATUS_LABELS: Record<string, string> = {
	active: "Active",
	suspended: "Suspended",
	deleting: "Deleting",
	deleted: "Deleted",
};

export interface InboxCounts {
	waiting: number;
	submitted: number;
	working: number;
	inputRequired: number;
	completed: number;
	failed: number;
	rejected: number;
	canceled: number;
	pairingPending: number;
}

function countOf(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) return null;
	return value;
}

/** Task and pairing counts. Anything other than those numbers is ignored. */
export function inboxCountsOf(body: unknown): InboxCounts | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const tasks = (body as { tasks?: unknown }).tasks;
	if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return null;
	const record = tasks as Record<string, unknown>;
	const values: Record<(typeof TASK_STATES)[number], number> = {
		submitted: 0, working: 0, "input-required": 0, completed: 0, failed: 0, rejected: 0, canceled: 0,
	};
	for (const state of TASK_STATES) {
		const value = countOf(record[state]);
		if (value === null) return null;
		values[state] = value;
	}
	const pairingPending = countOf((body as { pairingPending?: unknown }).pairingPending);
	if (pairingPending === null) return null;
	return {
		waiting: values.submitted + values.working,
		submitted: values.submitted,
		working: values.working,
		inputRequired: values["input-required"],
		completed: values.completed,
		failed: values.failed,
		rejected: values.rejected,
		canceled: values.canceled,
		pairingPending,
	};
}

function httpsUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
		return url.pathname === "/" ? url.origin : url.href;
	} catch {
		return "";
	}
}

export function renderOverview(input: { status: string; publicUrl: string; counts: InboxCounts | null }): string {
	const url = httpsUrl(input.publicUrl);
	const card = url ? httpsUrl(new URL("/.well-known/agent-card.json", url).href) : "";
	const counts = input.counts;
	return (
		<section class="overview">
			<h2>Overview</h2>
			<dl>
				<dt>Status</dt>
				<dd>{STATUS_LABELS[input.status] ?? "Unknown"}</dd>
				<dt>URL</dt>
				<dd>{url ? <a href={url}>{url}</a> : "No public URL is set."}</dd>
				<dt>Card</dt>
				<dd>{card ? <a href={card}>{card}</a> : "No card URL is set."}</dd>
			</dl>
			<h3>Inbox</h3>
			{counts ? (
				<dl>
					<dt>Waiting</dt>
					<dd>{counts.waiting}</dd>
					<dt>Submitted</dt>
					<dd>{counts.submitted}</dd>
					<dt>Working</dt>
					<dd>{counts.working}</dd>
					<dt>Needs input</dt>
					<dd>{counts.inputRequired}</dd>
					<dt>Completed</dt>
					<dd>{counts.completed}</dd>
					<dt>Failed</dt>
					<dd>{counts.failed}</dd>
					<dt>Rejected</dt>
					<dd>{counts.rejected}</dd>
					<dt>Canceled</dt>
					<dd>{counts.canceled}</dd>
					<dt>Pending pairing</dt>
					<dd>{counts.pairingPending}</dd>
				</dl>
			) : <p>Inbox counts are not available.</p>}
		</section>
	).toString();
}
