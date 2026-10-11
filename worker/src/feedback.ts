// Feedback from an owner-only MCP tool. A hosted tenant posts to the control plane.
// Any other deploy returns a prefilled GitHub issue URL and does not call out.
import { reachesControl } from "./approval-oidc.ts";
import { scrubSecretText } from "./export.ts";
import type { TenantContext } from "./tenancy.ts";

export const ISSUE_REPO = "telegraphic-dev/a2a-exposed";
const TIMEOUT_MS = 5000;
const BEARER_RE = /bearer\s+\S{8,200}/gi;
const KINDS = ["bug", "idea", "other"] as const;

export type FeedbackKind = (typeof KINDS)[number];

export interface FeedbackNote {
	message: string;
	kind: string;
	contact: string;
	version: string;
	steps?: string;
	expected?: string;
	actual?: string;
	agent?: string;
	environment?: string;
	os?: string;
	node?: string;
	mode?: string;
}

/** scrubSecretText, then a Bearer value. The rest of the text stays. */
export function scrubFeedbackText(value: string): string {
	return scrubSecretText(value).replace(BEARER_RE, "Bearer [redacted]");
}

/** https origin + /api/feedback when this tenant is hosted and FEEDBACK_URL is that origin. Otherwise "". */
export function feedbackEndpoint(ctx: TenantContext): string {
	if (ctx.mode !== "host") return "";
	const origin = ctx.gates.feedbackUrl;
	if (!origin) return "";
	return `${origin}/api/feedback`;
}

export function feedbackIssueUrl(title: string, body: string): string {
	const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
	url.searchParams.set("title", title);
	url.searchParams.set("body", body);
	return url.href;
}

function pageHost(ctx: TenantContext): string {
	try { return new URL(ctx.PUBLIC_URL).hostname; } catch { return ""; }
}

function acceptedIssueUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 300) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return "";
		if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/.test(url.pathname)) return "";
		return `${url.origin}${url.pathname}`;
	} catch {
		return "";
	}
}

const SECTIONS: [keyof FeedbackNote, string, number][] = [
	["steps", "Steps", 4000],
	["expected", "Expected", 2000],
	["actual", "Actual", 2000],
	["agent", "Agent", 80],
	["environment", "Environment", 120],
	["os", "OS", 80],
	["node", "Node", 32],
	["mode", "Mode", 16],
	["contact", "Contact", 200],
];

function piece(value: string, max: number): string {
	return scrubFeedbackText(value).trim().slice(0, max);
}

function documentOf(input: FeedbackNote, kind: FeedbackKind): { title: string; body: string } {
	const message = piece(input.message, 4000);
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const head = ["Source: mcp", `Kind: ${kind}`];
	const version = piece(input.version || "", 64);
	if (version) head.push(`Version: ${version}`);
	const parts = [head.join("\n"), `## What happened\n\n${message}`];
	for (const [key, heading, max] of SECTIONS) {
		const text = piece(String(input[key] ?? ""), max);
		if (text) parts.push(`## ${heading}\n\n${text}`);
	}
	return { title, body: parts.join("\n\n") };
}

function modeOf(ctx: TenantContext, given: string): string {
	if (!given) return ctx.mode === "host" ? "hosted" : "self-host";
	if (given === "hosted" || given === "self-host") return given;
	throw new Error("mode must be hosted or self-host");
}

async function postFeedback(ctx: TenantContext, endpoint: string, body: string, fetchImpl?: typeof fetch): Promise<Response> {
	const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
	const key = ctx.feedbackRateKey();
	if (key) headers.authorization = `Bearer ${key}`;
	const binding = ctx.controlService();
	let host = "";
	try { host = new URL(endpoint).hostname; } catch { host = ""; }
	const viaBinding = !!(binding && host && reachesControl(pageHost(ctx), host, ctx.gates.tenantDomain));
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	if (viaBinding) {
		const bound = new Headers(headers);
		bound.set("host", new URL(endpoint).host);
		const req = new Request(endpoint, { method: "POST", headers: bound, body });
		return binding!.fetch(req, { signal });
	}
	return (fetchImpl ?? fetch)(endpoint, { method: "POST", headers, body, redirect: "error", signal });
}

/**
 * File the note when this tenant is hosted and the control plane accepts it.
 * No endpoint, or a 404, returns the prefilled issue URL and does not throw.
 * Anything else throws a short error with none of the message.
 */
export async function sendFeedback(ctx: TenantContext, input: FeedbackNote, fetchImpl?: typeof fetch): Promise<{ filed: boolean; issue_url: string }> {
	const message = String(input.message ?? "");
	if (!message.trim() || message.length > 4000) throw new Error("message must be 1-4000 characters");
	if (input.kind && !KINDS.includes(input.kind as FeedbackKind)) throw new Error("kind must be bug, idea, or other");
	if ((input.contact || "").length > 200) throw new Error("contact is too long");
	if ((input.steps || "").length > 4000) throw new Error("steps is too long");
	if ((input.expected || "").length > 2000 || (input.actual || "").length > 2000) throw new Error("expected or actual is too long");
	if ((input.agent || "").length > 80) throw new Error("agent is too long");
	if ((input.environment || "").length > 120) throw new Error("environment is too long");
	const kind: FeedbackKind = KINDS.includes(input.kind as FeedbackKind) ? input.kind as FeedbackKind : "other";
	const note: FeedbackNote = { ...input, message, kind, mode: modeOf(ctx, input.mode || "") };
	const doc = documentOf(note, kind);
	const fallback = feedbackIssueUrl(doc.title, doc.body);
	const endpoint = feedbackEndpoint(ctx);
	if (!endpoint) return { filed: false, issue_url: fallback };
	let response: Response;
	try {
		response = await postFeedback(ctx, endpoint, JSON.stringify({
			message: scrubFeedbackText(message),
			kind,
			contact: scrubFeedbackText(input.contact || ""),
			source: "mcp",
			agent: scrubFeedbackText(input.agent || ""),
			version: scrubFeedbackText(input.version || ""),
			steps: scrubFeedbackText(input.steps || ""),
			expected: scrubFeedbackText(input.expected || ""),
			actual: scrubFeedbackText(input.actual || ""),
			environment: scrubFeedbackText(input.environment || ""),
			os: scrubFeedbackText(input.os || ""),
			node: scrubFeedbackText(input.node || ""),
			mode: note.mode,
		}), fetchImpl);
	} catch {
		throw new Error("feedback could not be filed");
	}
	if (response.status === 404) {
		await response.body?.cancel().catch(() => {});
		return { filed: false, issue_url: fallback };
	}
	let payload: unknown = null;
	try { payload = await response.json(); } catch { payload = null; }
	const issue = acceptedIssueUrl(payload && typeof payload === "object" ? (payload as { issue_url?: unknown }).issue_url : "");
	if (response.ok && issue) return { filed: true, issue_url: issue };
	if (response.status === 429) throw new Error("too many feedback reports; try again later");
	throw new Error("feedback could not be filed");
}
