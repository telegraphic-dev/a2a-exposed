const MCP_NOTICES: Record<string, string> = {
	revoked: "Revoked. That connector no longer works.",
};

const MCP_ERRORS: Record<string, string> = {
	failed: "That change was not saved.",
	label: "That is not a connector label.",
	missing: "That connector is not active.",
};

const EXPORT_ERRORS: Record<string, string> = {
	failed: "The export was not downloaded.",
};

const LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /(?:a2aow_|s2a_|a2amcp_|a2amcpr_)[A-Za-z0-9_-]{20,}/;
const SETUP_RE = /(?:\?|&)t=[A-Za-z0-9_-]{16,}/;

export interface McpConnector {
	label: string;
	name: string;
	host: string;
	since: string;
	used: string;
}

export interface LogEntry {
	ts: string;
	dir: string;
	peer: string;
	text: string;
	event: string;
	state: string;
}

function plain(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/[\u0000-\u001f]/g, "").trim();
	if (!text || text.length > max || TOKEN_RE.test(text) || SETUP_RE.test(text)) return "";
	return text;
}

function when(value: unknown): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) || value.length > 40) return "";
	return value.slice(0, 16).replace("T", " ");
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

export function renderRecords(input: {
	name: string;
	mcp: { enabled: boolean; connectors: McpConnector[] } | null;
	entries: LogEntry[] | null;
	confirmLabel: string;
	mcpNotice: string;
	exportNotice: string;
}): string {
	const action = `/app/agents/${input.name}`;
	const note = MCP_NOTICES[input.mcpNotice] ?? "";
	const problem = MCP_ERRORS[input.mcpNotice] ?? "";
	const exportProblem = EXPORT_ERRORS[input.exportNotice] ?? "";
	const confirm = input.mcp?.connectors.find((row) => row.label === input.confirmLabel) ?? null;
	return (
		<section class="records">
			<h2>MCP connectors</h2>
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
								<button class="action" type="submit">Revoke connector</button>
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
								{row.since ? <><dt>Since</dt><dd>{row.since}</dd></> : ""}
								{row.used ? <><dt>Last used</dt><dd>{row.used}</dd></> : ""}
							</dl>
							<form method="post" action={action}>
								<input type="hidden" name="action" value="revoke-mcp" />
								<input type="hidden" name="label" value={row.label} />
								<button class="action deny" type="submit">Revoke</button>
							</form>
						</article>
					))}
				</>
			)}
			<h2>Message log</h2>
			<p>Recent history. Reading this log does not mark a task as seen.</p>
			{input.entries === null ? <p>The message log is not available.</p> : input.entries.length === 0 ? <p>No messages.</p> : (
				<ul class="log">
					{input.entries.map((row) => (
						<li>
							{row.ts ? <span>{row.ts}</span> : ""}
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
			)}
			<h2>Export</h2>
			<p>Download a SQL copy of this agent. Stored token hashes are replaced and do not authenticate. Ciphertext, push tokens, OAuth codes, the approval-password hash, and OpenID Connect sign-in rows are left out. This file is not a backup. The full dump is <code>npx a2a-exposed export</code> with the owner token.</p>
			{exportProblem ? <p class="alert" role="alert">{exportProblem}</p> : ""}
			<form method="post" action={action}>
				<input type="hidden" name="action" value="export" />
				<button class="action" type="submit">Download SQL</button>
			</form>
		</section>
	).toString();
}
