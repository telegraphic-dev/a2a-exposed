import { hasToken, scrubTokenText } from "./tokens.ts";

const MCP_NOTICES: Record<string, string> = {
	revoked: "Revoked. That connector no longer works.",
};

const MCP_ERRORS: Record<string, string> = {
	failed: "That change was not saved.",
	label: "That is not a connector label.",
	missing: "That connector is not active.",
};

const LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const SETUP_RE = /(?:\?|&)t=[A-Za-z0-9_-]{16,}/;

export interface McpConnector {
	label: string;
	name: string;
	host: string;
	since: { text: string; datetime: string } | null;
	used: { text: string; datetime: string } | null;
}

export interface LogEntry {
	ts: { text: string; datetime: string } | null;
	dir: string;
	peer: string;
	text: string;
	event: string;
	state: string;
}

function plain(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = scrubTokenText(value.replace(/[\u0000-\u001f]/g, "")).trim();
	if (!text || text.length > max || hasToken(text) || SETUP_RE.test(text)) return "";
	return text;
}

function when(value: unknown): { text: string; datetime: string } | null {
	if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
	if (!Number.isFinite(Date.parse(value))) return null;
	return { text: `${value.slice(0, 16).replace("T", " ")} UTC`, datetime: value };
}

/** Active MCP connectors. Null when the response is not a connector list. Extra fields are ignored. */
export function mcpConnectorsOf(body: unknown): { enabled: boolean; connectors: McpConnector[] } | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const grants = (body as { grants?: unknown }).grants;
	if (!Array.isArray(grants)) return null;
	const enabled = (body as { enabled?: unknown }).enabled === true;
	const connectors: McpConnector[] = [];
	for (const row of grants) {
		if (!row || typeof row !== "object") continue;
		const record = row as { label?: unknown; client_name?: unknown; redirect_host?: unknown; created_at?: unknown; last_used_at?: unknown; revoked_at?: unknown };
		if (record.revoked_at) continue;
		const label = plain(record.label, 64);
		if (!LABEL.test(label)) continue;
		connectors.push({
			label,
			name: plain(record.client_name, 200),
			host: plain(record.redirect_host, 200),
			since: when(record.created_at),
			used: when(record.last_used_at),
		});
		if (connectors.length >= 100) break;
	}
	return { enabled, connectors };
}

/** Recent history. Null when the response is not a log. Extra fields, including data_json, are ignored. */
export function logEntriesOf(body: unknown): LogEntry[] | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const entries = (body as { entries?: unknown }).entries;
	if (!Array.isArray(entries)) return null;
	const out: LogEntry[] = [];
	for (const row of entries) {
		if (!row || typeof row !== "object") continue;
		const record = row as { ts?: unknown; dir?: unknown; peer?: unknown; text?: unknown; event?: unknown; state?: unknown };
		const dir = record.dir === "in" || record.dir === "out" || record.dir === "local" ? record.dir : "";
		out.push({
			ts: when(record.ts),
			dir,
			peer: plain(record.peer, 200),
			text: plain(record.text, 2000),
			event: plain(record.event, 64),
			state: plain(record.state, 32),
		});
		if (out.length >= 100) break;
	}
	return out;
}

function reauthNote(href: string) {
	if (!href) return "";
	return (
		<p class="alert" role="status">Your sign-in is older than 10 minutes. <a href={href}>Sign in again</a> before you approve, deny, revoke, rotate, or delete.</p>
	);
}

export function renderRecords(input: {
	name: string;
	mcp: { enabled: boolean; connectors: McpConnector[] } | null;
	entries: LogEntry[] | null;
	confirmLabel: string;
	mcpNotice: string;
	reauthHref?: string;
}): string {
	const action = `/app/agents/${input.name}`;
	const note = MCP_NOTICES[input.mcpNotice] ?? "";
	const problem = MCP_ERRORS[input.mcpNotice] ?? "";
	const confirm = input.mcp?.connectors.find((row) => row.label === input.confirmLabel) ?? null;
	return (
		<section class="records">
			<h2>MCP connectors</h2>
			{reauthNote(input.reauthHref ?? "")}
			{note ? <p class="alert" role="status">{note}</p> : ""}
			{problem ? <p class="alert" role="alert">{problem}</p> : ""}
			{input.mcp === null ? <p>MCP connectors are not available.</p> : (
				<>
					<p>{input.mcp.enabled ? "MCP is on." : "MCP is off."}</p>
					{confirm ? (
						<div class="confirm">
							<p>Revoke the connector {confirm.label}? That client will no longer be able to call this agent.</p>
							<form method="post" action={action}>
								<input type="hidden" name="action" value="revoke-mcp" />
								<input type="hidden" name="label" value={confirm.label} />
								<input type="hidden" name="confirm" value="1" />
								<button class="danger" type="submit">Revoke connector</button>
							</form>
						</div>
					) : ""}
					{input.mcp.connectors.length === 0 ? <p>No MCP connectors.</p> : input.mcp.connectors.map((row) => (
						<article>
							<dl>
								<dt>Label</dt>
								<dd><code>{row.label}</code></dd>
								<dt>Name (claimed)</dt>
								<dd>{row.name || "(none given)"}</dd>
								<dt>Redirect host</dt>
								<dd>{row.host || "(none)"}</dd>
								{row.since ? <><dt>Since</dt><dd><time datetime={row.since.datetime}>{row.since.text}</time></dd></> : ""}
								{row.used ? <><dt>Last used</dt><dd><time datetime={row.used.datetime}>{row.used.text}</time></dd></> : ""}
							</dl>
							<form method="post" action={action}>
								<input type="hidden" name="action" value="revoke-mcp" />
								<input type="hidden" name="label" value={row.label} />
								<button class="danger" type="submit">Revoke</button>
							</form>
						</article>
					))}
				</>
			)}
			<h2>Message log</h2>
			<p>Recent history. Reading this log does not mark a task as seen.</p>
			{input.entries === null ? <p>The message log is not available.</p> : input.entries.length === 0 ? <p>No messages.</p> : (
				<details class="log-fold">
					<summary>Latest messages</summary>
					<ul class="log">
						{input.entries.slice(0, 5).map((row) => (
							<li>
								{row.ts ? <time datetime={row.ts.datetime}>{row.ts.text}</time> : ""}
								{" "}
								{row.dir ? <code>{row.dir}</code> : ""}
								{" "}
								{row.peer ? <span>{row.peer}</span> : ""}
								{" "}
								{row.event || row.state ? <span>{[row.event, row.state].filter(Boolean).join(" ")}</span> : ""}
								{row.text ? <p>{row.text}</p> : ""}
							</li>
						))}
					</ul>
				</details>
			)}
		</section>
	).toString();
}
