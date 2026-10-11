import { WAKE_PRESETS } from "../tenants/wake.ts";

const PLAIN_HEADERS = new Set([
	"content-type", "user-agent", "x-request-id", "idempotency-key", "anthropic-version", "x-webhook-timestamp",
]);

const PRESET_LABELS: Record<(typeof WAKE_PRESETS)[number], string> = {
	"grok-bot": "Grok Bot",
	"claude-code": "Claude Code",
	"openclaw-wake": "OpenClaw wake",
	"openclaw-agent": "OpenClaw agent",
	hermes: "Hermes",
	generic: "Generic",
};

const ERRORS: Record<string, string> = {
	origin: "That request came from another site.",
	url: "Use an https URL with no username or password.",
	preset: "Choose a wake preset.",
	header: "Use a header name of letters, numbers, or hyphens. It cannot be a header the preview shows in full.",
	key: "That key is not valid.",
	unavailable: "Wake settings are not available.",
	unreadable: "The saved wake key could not be read. It was not changed.",
	conflict: "Those settings were saved by another request. Reload and try again.",
};

export interface WakePreview {
	configured: boolean;
	hasKey: boolean;
	lines: string[];
}

/** Masked request lines. A credential header that is still in the clear is not shown. */
export function wakePreviewOf(body: unknown): WakePreview {
	const record = body && typeof body === "object" ? body as { configured?: unknown; hasKey?: unknown; request?: unknown } : {};
	const request = record.request && typeof record.request === "object"
		? record.request as { method?: unknown; url?: unknown; headers?: unknown }
		: null;
	const lines: string[] = [];
	if (request) {
		if (typeof request.method === "string" && request.method.length < 16) lines.push(request.method);
		if (typeof request.url === "string" && request.url.length < 2000 && !request.url.includes("@")) lines.push(request.url);
		if (request.headers && typeof request.headers === "object" && !Array.isArray(request.headers)) {
			for (const [name, value] of Object.entries(request.headers)) {
				if (typeof value !== "string" || value.length > 200) continue;
				const shown = PLAIN_HEADERS.has(name.toLowerCase())
					? value
					: value === "••••" || value === "Bearer ••••" ? `${value} (set)` : "•••• (set)";
				lines.push(`${name}: ${shown}`);
			}
		}
	}
	return {
		configured: record.configured === true,
		hasKey: record.hasKey === true,
		lines,
	};
}

function testMessage(code: string): string {
	if (code === "none") return "No wake URL is set.";
	if (code === "failed") return "The test wake was not sent.";
	if (code === "tls") return "TLS handshake failed.";
	if (code === "https") return "The wake URL must be https, with no username or password.";
	if (code === "private") return "The wake URL is not a public address.";
	if (code === "dns") return "The wake host could not be checked.";
	if (code === "redirect") return "The wake URL redirected to another site.";
	if (/^[1-5][0-9]{2}$/.test(code)) return `The test wake returned HTTP ${code}.`;
	return "";
}

export function renderWakeSection(input: {
	name: string;
	url: string;
	preset: string;
	keyHeader: string;
	preview: WakePreview | null;
	notice?: string;
	error?: string;
	test?: string;
}): string {
	const error = input.error ? ERRORS[input.error] ?? "" : "";
	const tested = input.test ? testMessage(input.test) : "";
	const action = `/app/agents/${input.name}`;
	return (
		<section class="wake">
			<h2>Wake</h2>
			{input.notice === "saved" ? <p role="status">Wake settings saved.</p> : ""}
			{tested ? <p role="status">{tested}</p> : ""}
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{input.preview?.lines.length ? (
				<pre class="preview">{input.preview.lines.join("\n")}</pre>
			) : <p>{input.preview ? "No wake URL is set." : "The wake preview is unavailable."}</p>}
			{input.preview?.hasKey ? <p>A key is saved. Leave the key blank to keep it.</p> : ""}
			{input.preset === "claude-code" ? <p>Claude Code starts a new cloud session on each wake.</p> : ""}
			<form method="post" action={action}>
				<input type="hidden" name="action" value="save" />
				<p>
					<label>
						URL
						<input name="url" type="url" value={input.url} autocomplete="off" maxlength={2000} />
					</label>
				</p>
				<p>
					<label>
						Preset
						<select name="preset">
							{WAKE_PRESETS.map((preset) => (
								<option value={preset} selected={preset === input.preset}>{PRESET_LABELS[preset]}</option>
							))}
						</select>
					</label>
				</p>
				<p>
					<label>
						Key header
						<input name="key_header" value={input.keyHeader} autocomplete="off" maxlength={64} />
					</label>
				</p>
				<p>The generic preset sends the key in this header. Leave it blank to use Authorization. Other presets use Authorization.</p>
				<p>
					<label>
						Key
						<input name="key" type="password" value="" autocomplete="off" maxlength={4096} />
					</label>
				</p>
				<p><button class="action" type="submit">Save wake settings</button></p>
			</form>
			<form method="post" action={action}>
				<input type="hidden" name="action" value="test" />
				<p><button type="submit">Send test wake</button></p>
			</form>
		</section>
	).toString();
}
