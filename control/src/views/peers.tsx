const NOTICES: Record<string, string> = {
	approved: "Approved. That agent can collect its token.",
	denied: "Denied. That agent gets no token.",
	revoked: "Revoked. That token no longer works.",
};

const ERRORS: Record<string, string> = {
	failed: "That change was not saved.",
	code: "That is not a pairing code.",
	label: "That is not a peer label.",
	decided: "That request was already decided or has expired.",
	missing: "That token is not active.",
};

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}[2-9]{4}$/;
const LABEL = /^[A-Za-z0-9_-]{1,32}$/;
const ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN_RE = /(?:a2aow_|s2a_|a2amcp_|a2amcpr_|a2aot_)[A-Za-z0-9_-]{20,}/;
const SETUP_RE = /(?:\?|&)t=[A-Za-z0-9_-]{16,}/;

export interface UtcStamp {
	text: string;
	datetime: string;
}

export interface PendingPairing {
	code: string;
	name: string;
	alias: string;
	cardText: string;
	cardHref: string;
	expires: UtcStamp | null;
	replaces: string;
}

export interface InboundPeer {
	label: string;
	source: string;
	code: string;
	name: string;
	since: UtcStamp | null;
}

export interface OutboundPeer {
	alias: string;
	url: string;
	href: string;
	hasToken: boolean;
}

function plain(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/[\u0000-\u001f]/g, "").trim();
	if (!text || text.length > max || TOKEN_RE.test(text) || SETUP_RE.test(text)) return "";
	return text;
}

function formatCode(value: unknown): string {
	const raw = plain(value, 16).toUpperCase().replace(/-/g, "");
	return CODE.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : "";
}

/** UTC instant from an ISO timestamp that ends in Z. The label says UTC; the attribute keeps the instant. */
function when(value: unknown): UtcStamp | null {
	if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
	if (!Number.isFinite(Date.parse(value))) return null;
	return { text: `${value.slice(0, 16).replace("T", " ")} UTC`, datetime: value };
}

/** Hosts that only resolve on a private network. Same classification as the Worker's `isPrivateHost`. */
function privateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!h.includes(".") && !h.includes(":")) return true;
	if (/(^|\.)(localhost|local|lan|home|internal|intranet|corp|home\.arpa|ts\.net)$/.test(h)) return true;
	const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	if (!h.includes(":")) return false;
	if (h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^fec/.test(h)) return true;
	const e = h.match(/^(?:::ffff:|64:ff9b::|::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
	if (e) {
		const v4 = e[1] || [parseInt(e[2]!, 16) >> 8, parseInt(e[2]!, 16) & 255, parseInt(e[3]!, 16) >> 8, parseInt(e[3]!, 16) & 255].join(".");
		return privateHost(v4);
	}
	return false;
}

/** Text of a claimed URL, and an href only for a public https URL with no query or userinfo. */
function cardOf(value: unknown): { text: string; href: string } {
	const text = plain(value, 500);
	if (!text) return { text: "", href: "" };
	try {
		const url = new URL(text);
		const linkable = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !privateHost(url.hostname);
		const href = linkable ? (url.pathname === "/" ? url.origin : url.href) : "";
		return { text, href };
	} catch {
		return { text, href: "" };
	}
}

/** Pending requests. Null when the response is not a pairing list. Extra fields are ignored. */
export function pendingPairingsOf(body: unknown): PendingPairing[] | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const pending = (body as { pending?: unknown }).pending;
	if (!Array.isArray(pending)) return null;
	const out: PendingPairing[] = [];
	for (const row of pending) {
		if (!row || typeof row !== "object") continue;
		const record = row as { userCode?: unknown; clientName?: unknown; clientId?: unknown; agentCardUrl?: unknown; expiresAt?: unknown; replacesLabel?: unknown };
		const code = formatCode(record.userCode);
		if (!code) continue;
		const card = cardOf(record.agentCardUrl);
		const replaces = plain(record.replacesLabel, 32);
		out.push({
			code,
			name: plain(record.clientName, 200),
			alias: plain(record.clientId, 200),
			cardText: card.text,
			cardHref: card.href,
			expires: when(record.expiresAt),
			replaces: LABEL.test(replaces) ? replaces : "",
		});
		if (out.length >= 50) break;
	}
	return out;
}

/** Active inbound peers. Revoked rows and token fields are left out. */
export function inboundPeersOf(body: unknown): InboundPeer[] | null {
	if (!Array.isArray(body)) return null;
	const out: InboundPeer[] = [];
	for (const row of body) {
		if (!row || typeof row !== "object") continue;
		const record = row as { label?: unknown; revoked_at?: unknown; source?: unknown; client_name?: unknown; created_at?: unknown; user_code?: unknown };
		if (record.revoked_at) continue;
		const label = plain(record.label, 32);
		if (!LABEL.test(label)) continue;
		const recordCode = formatCode(record.user_code);
		const source = record.source == null || record.source === "" ? "issued" : record.source === "pairing" ? "pairing" : "other";
		out.push({ label, source, code: source === "pairing" ? recordCode : "", name: plain(record.client_name, 200), since: when(record.created_at) });
		if (out.length >= 100) break;
	}
	return out;
}

/** Outbound peers. The token itself is not read. */
export function outboundPeersOf(body: unknown): OutboundPeer[] | null {
	if (!Array.isArray(body)) return null;
	const out: OutboundPeer[] = [];
	for (const row of body) {
		if (!row || typeof row !== "object") continue;
		const record = row as { alias?: unknown; url?: unknown; has_token?: unknown };
		const alias = plain(record.alias, 64);
		if (!ALIAS.test(alias) || alias === "." || alias === "..") continue;
		const card = cardOf(record.url);
		out.push({ alias, url: card.text, href: card.href, hasToken: record.has_token === true });
		if (out.length >= 100) break;
	}
	return out;
}

export function renderPeers(input: {
	name: string;
	pending: PendingPairing[] | null;
	inbound: InboundPeer[] | null;
	outbound: OutboundPeer[] | null;
	confirmLabel: string;
	peer: string;
}): string {
	const action = `/app/agents/${input.name}`;
	const note = NOTICES[input.peer] ?? "";
	const problem = ERRORS[input.peer] ?? "";
	const confirm = input.inbound?.find((peer) => peer.label === input.confirmLabel) ?? null;
	return (
		<section class="peers">
			<h2>Pairing</h2>
			{note ? <p class="alert" role="status">{note}</p> : ""}
			{problem ? <p class="alert" role="alert">{problem}</p> : ""}
			<p>The name, alias, and card URL are claimed by the requester.</p>
			<h3>Pending requests</h3>
			{input.pending === null ? <p>Pairing requests are not available.</p> : input.pending.length === 0 ? <p>No pending pairing requests.</p> : input.pending.map((row) => (
				<article>
					<dl>
						<dt>Code</dt>
						<dd><code>{row.code}</code></dd>
						<dt>Name (claimed)</dt>
						<dd>{row.name || "(none given)"}</dd>
						<dt>Alias (claimed)</dt>
						<dd>{row.alias || "(none given)"}</dd>
						<dt>Card (claimed)</dt>
						<dd>{row.cardHref ? <a href={row.cardHref} rel="noreferrer">{row.cardText}</a> : row.cardText || "(none given)"}</dd>
						{row.expires ? <><dt>Expires</dt><dd><time datetime={row.expires.datetime}>{row.expires.text}</time></dd></> : ""}
						{row.replaces ? <><dt>Replaces</dt><dd>the token {row.replaces}</dd></> : ""}
					</dl>
					<div class="actions">
						<form method="post" action={action}>
							<input type="hidden" name="action" value="approve" />
							<input type="hidden" name="code" value={row.code} />
							<button class="action" type="submit">Approve</button>
						</form>
						<form method="post" action={action}>
							<input type="hidden" name="action" value="deny" />
							<input type="hidden" name="code" value={row.code} />
							<button class="action deny" type="submit">Deny</button>
						</form>
					</div>
				</article>
			))}
			<h3>Inbound peers</h3>
			{confirm ? (
				<div class="confirm">
					<p>Revoke the token for {confirm.label}? That peer will no longer be able to send messages.</p>
					<form method="post" action={action}>
						<input type="hidden" name="action" value="revoke" />
						<input type="hidden" name="label" value={confirm.label} />
						<input type="hidden" name="confirm" value="1" />
						<button class="action" type="submit">Revoke token</button>
					</form>
				</div>
			) : ""}
			{input.inbound === null ? <p>Inbound peers are not available.</p> : input.inbound.length === 0 ? <p>No inbound peers.</p> : input.inbound.map((peer) => (
				<article>
					<dl>
						<dt>Label</dt>
						<dd><code>{peer.label}</code></dd>
						<dt>Source</dt>
						<dd>{peer.code ? `pairing ${peer.code}` : peer.source}</dd>
						<dt>Name (claimed)</dt>
						<dd>{peer.name || "(none given)"}</dd>
						{peer.since ? <><dt>Since</dt><dd><time datetime={peer.since.datetime}>{peer.since.text}</time></dd></> : ""}
					</dl>
					<form method="post" action={action}>
						<input type="hidden" name="action" value="revoke" />
						<input type="hidden" name="label" value={peer.label} />
						<button class="action deny" type="submit">Revoke</button>
					</form>
				</article>
			))}
			<h3>Outbound peers</h3>
			{input.outbound === null ? <p>Outbound peers are not available.</p> : input.outbound.length === 0 ? <p>No outbound peers. Outbound peers this agent's CLI added locally do not appear here.</p> : (
				<ul>
					{input.outbound.map((peer) => (
						<li>
							<code>{peer.alias}</code>
							{" "}
							{peer.href ? <a href={peer.href} rel="noreferrer">{peer.url}</a> : peer.url || "(no URL)"}
							{" "}
							{peer.hasToken ? "(token stored)" : "(no token)"}
						</li>
					))}
				</ul>
			)}
		</section>
	).toString();
}
