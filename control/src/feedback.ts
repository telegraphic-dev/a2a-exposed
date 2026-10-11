// POST /api/feedback files a GitHub issue when both settings are present. Either one unset is 404,
// so a self-hosted control plane with no feedback config is unchanged.
// The token is a fine-grained personal access token (Issues write on FEEDBACK_REPO only).
// It is not named GITHUB_*: that prefix is the sign-in OAuth app.
import { connectingIp, verifyTurnstile, type TurnstileFailure } from "./auth/turnstile.ts";
import { sameOrigin } from "./auth/origin.ts";
import type { Sql } from "./auth/invites.ts";
import type { ControlEnv } from "./env.ts";

export const MESSAGE_MAX = 4000;
export const PER_HOUR = 5;
export const GITHUB_TIMEOUT_MS = 5000;
const WINDOW_MS = 60 * 60 * 1000;
const BODY_MAX = 16_000;
const CONTACT_MAX = 200;
const AGENT_MAX = 80;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KINDS = ["bug", "idea", "other"] as const;
const SOURCES = ["web", "cli", "mcp"] as const;

type Kind = (typeof KINDS)[number];
type Source = (typeof SOURCES)[number];

/** Same token shapes as the Worker's scrubSecretText, plus a Bearer value. Keep the prefixes in step with TOKEN_PREFIXES. */
const TOKEN_RE = /(?:a2aow_|s2a_|a2amcp_|a2amcpr_|a2aot_)[A-Za-z0-9_-]{20,}/g;
const SETUP_RE = /([?&])t=[A-Za-z0-9_-]{16,}/g;
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?\s]*@/gi;
const BEARER_RE = /bearer\s+\S{8,200}/gi;

export interface FeedbackDeps {
	fetch?: typeof fetch;
	now?: () => number;
	githubTimeoutMs?: number;
}

export interface FeedbackInput {
	message: string;
	kind: Kind;
	contact: string;
	source: Source;
	agent: string;
	version: string;
}

export type FeedbackResult =
	| { kind: "json"; status: number; body: Record<string, unknown>; headers?: Record<string, string> }
	| { kind: "redirect"; location: string }
	| { kind: "html"; html: string; turnstile: boolean };

export function feedbackRepo(env: ControlEnv): string {
	const repo = (env.FEEDBACK_REPO ?? "").trim();
	if (!repo || repo.length > 100 || repo.includes("..") || !REPO_RE.test(repo)) return "";
	return repo;
}

export function feedbackOn(env: ControlEnv): boolean {
	return Boolean((env.FEEDBACK_GITHUB_TOKEN ?? "").trim() && feedbackRepo(env));
}

export function turnstileOf(env: ControlEnv): { siteKey: string; secret: string } | null {
	const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
	const secret = (env.TURNSTILE_SECRET_KEY ?? "").trim();
	if (!siteKey || !secret) return null;
	return { siteKey, secret };
}

/** Strip peer, owner, MCP, and setup tokens, URL userinfo, and Bearer values. The rest of the text stays. */
export function scrubFeedbackText(value: string): string {
	return value
		.replace(TOKEN_RE, "[redacted]")
		.replace(SETUP_RE, "$1t=[redacted]")
		.replace(USERINFO_RE, "$1[redacted]@")
		.replace(BEARER_RE, "Bearer [redacted]");
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(value: string, max: number): string {
	const clean = scrubFeedbackText(value.replace(/\u0000/g, "")).trim();
	return clean.length > max ? clean.slice(0, max) : clean;
}

export function issueDocument(input: FeedbackInput, token: string): { title: string; body: string; labels: string[] } {
	let message = clip(input.message, MESSAGE_MAX);
	let contact = input.contact ? clip(input.contact, CONTACT_MAX) : "";
	let agent = input.agent ? clip(input.agent, AGENT_MAX) : "";
	if (token.length >= 8) {
		message = message.split(token).join("[redacted]");
		contact = contact.split(token).join("[redacted]");
		agent = agent.split(token).join("[redacted]");
	}
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${input.kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const lines = [`Source: ${input.source}`, `Kind: ${input.kind}`];
	if (input.version) lines.push(`Version: ${input.version}`);
	if (agent) lines.push(`Agent: ${escapeText(agent)}`);
	if (contact) lines.push(`Contact: ${escapeText(contact)}`);
	lines.push("", escapeText(message));
	const labels = ["feedback", ...(input.source === "cli" || input.source === "mcp" ? ["from-agent"] : [])];
	return { title, body: lines.join("\n"), labels };
}

function jsonResult(status: number, body: Record<string, unknown>, headers?: Record<string, string>): FeedbackResult {
	return { kind: "json", status, body, headers };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

export function parseFeedback(record: Record<string, unknown>): FeedbackInput | string {
	const message = field(record, "message").replace(/\u0000/g, "");
	if (!message.trim() || message.length > MESSAGE_MAX) return "invalid_message";
	const kind = field(record, "kind") || "other";
	if (!KINDS.includes(kind as Kind)) return "invalid_kind";
	const source = field(record, "source");
	if (!SOURCES.includes(source as Source)) return "invalid_source";
	const contact = field(record, "contact");
	if (contact.length > CONTACT_MAX) return "invalid_contact";
	const agent = field(record, "agent");
	if (agent.length > AGENT_MAX) return "invalid_agent";
	const version = field(record, "version");
	if (version && !VERSION_RE.test(version)) return "invalid_version";
	return { message, kind: kind as Kind, contact, source: source as Source, agent, version };
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request): string {
	const header = (request.headers.get("authorization") ?? "").trim();
	const match = /^Bearer\s+(\S{1,200})$/i.exec(header);
	return match?.[1] ?? "";
}

async function allow(db: Sql | undefined, memory: Map<string, number>, bucket: string, windowStart: number): Promise<boolean> {
	const key = `${bucket}\0${windowStart}`;
	if (!db) {
		for (const stored of memory.keys()) {
			const start = Number(stored.split("\0")[1]);
			if (start < windowStart - 2) memory.delete(stored);
		}
		const count = memory.get(key) ?? 0;
		if (count >= PER_HOUR) return false;
		memory.set(key, count + 1);
		return true;
	}
	// One statement, so two requests cannot both pass a count check and then both insert.
	const updated = await db.prepare(
		`INSERT INTO feedback_rate (bucket, window_start, count) VALUES (?, ?, 1)
		 ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`,
	).bind(bucket, windowStart, PER_HOUR).run();
	await db.prepare("DELETE FROM feedback_rate WHERE window_start < ?").bind(windowStart - 2).run();
	return (updated.meta?.changes ?? 0) > 0;
}

/** A private bucket only for a bearer that is an owner token (or its stored hash). Anything else stays on the IP bucket. */
async function ownerBucket(db: Sql | undefined, token: string): Promise<string> {
	if (!db || !token) return "";
	const hex = token.toLowerCase();
	const hash = /^[0-9a-f]{64}$/.test(hex) ? hex : await sha256(token);
	const row = await db.prepare("SELECT owner_token_hash AS h FROM tenants WHERE owner_token_hash = ?")
		.bind(hash).first<{ h: string }>();
	return row?.h ? `tok:${hash}` : "";
}

function retryAfter(now: number): string {
	const left = WINDOW_MS - (now % WINDOW_MS);
	return String(Math.max(1, Math.ceil(left / 1000)));
}

function githubIssueUrl(repo: string, value: unknown): string {
	if (typeof value !== "string" || value.length > 300) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return "";
		const prefix = `/${repo}/issues/`;
		if (!url.pathname.startsWith(prefix)) return "";
		const number = url.pathname.slice(prefix.length);
		if (!/^\d+$/.test(number)) return "";
		return `${url.origin}${url.pathname}`;
	} catch {
		return "";
	}
}

async function openIssue(env: ControlEnv, input: FeedbackInput, deps: FeedbackDeps): Promise<FeedbackResult> {
	const repo = feedbackRepo(env);
	const token = (env.FEEDBACK_GITHUB_TOKEN ?? "").trim();
	const doc = issueDocument(input, token);
	const timeout = deps.githubTimeoutMs ?? GITHUB_TIMEOUT_MS;
	const call = deps.fetch ?? fetch;
	const post = (labels: string[]) => call(`https://api.github.com/repos/${repo}/issues`, {
		method: "POST",
		redirect: "error",
		signal: AbortSignal.timeout(timeout),
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "a2a-exposed",
			"x-github-api-version": "2022-11-28",
		},
		body: JSON.stringify(labels.length ? { title: doc.title, body: doc.body, labels } : { title: doc.title, body: doc.body }),
	});
	let response: Response;
	try {
		response = await post(doc.labels);
		if (response.status === 422) {
			await response.body?.cancel().catch(() => {});
			response = await post([]);
		}
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const timeoutHit = name === "TimeoutError" || name === "AbortError";
		console.error(JSON.stringify({ event: "feedback_failed", source: input.source, status: 0, error: timeoutHit ? "timeout" : "fetch" }));
		return jsonResult(timeoutHit ? 504 : 502, { error: timeoutHit ? "timeout" : "unavailable" });
	}
	let payload: unknown = null;
	try { payload = await response.json(); } catch { payload = null; }
	const issue = githubIssueUrl(repo, asRecord(payload)?.html_url);
	if (response.ok && issue) {
		console.error(JSON.stringify({ event: "feedback_filed", source: input.source, status: response.status }));
		return jsonResult(200, { ok: true, issue_url: issue });
	}
	console.error(JSON.stringify({ event: "feedback_failed", source: input.source, status: response.status }));
	return jsonResult(502, { error: "unavailable" });
}

async function limited(request: Request, input: FeedbackInput, env: ControlEnv, memory: Map<string, number>, now: number): Promise<FeedbackResult | null> {
	const windowStart = Math.floor(now / WINDOW_MS);
	const token = input.source === "web" ? "" : bearerToken(request);
	let allowed = false;
	try {
		const owner = await ownerBucket(env.DB, token);
		const bucket = owner || `ip:${connectingIp(request) ?? "unknown"}`;
		allowed = await allow(env.DB, memory, bucket, windowStart);
	} catch {
		console.error(JSON.stringify({ event: "feedback_failed", source: input.source, status: 0, error: "rate" }));
		return jsonResult(503, { error: "unavailable" });
	}
	if (allowed) return null;
	return jsonResult(429, { error: "rate_limit" }, { "retry-after": retryAfter(now) });
}

function turnstileToken(request: Request, record: Record<string, unknown>): string {
	const fromJson = field(record, "turnstile");
	if (fromJson) return fromJson;
	return field(record, "cf-turnstile-response");
}

export async function submitFeedback(
	request: Request,
	env: ControlEnv,
	input: FeedbackInput,
	record: Record<string, unknown>,
	memory: Map<string, number>,
	deps: FeedbackDeps,
): Promise<FeedbackResult> {
	if (input.source === "web" && !sameOrigin(request)) return jsonResult(403, { error: "forbidden" });
	const turnstile = turnstileOf(env);
	if (input.source === "web" && turnstile) {
		const token = turnstileToken(request, record);
		if (!token) return jsonResult(400, { error: "turnstile" });
		const failure: TurnstileFailure | null = await verifyTurnstile(turnstile.secret, token, connectingIp(request));
		if (failure) return jsonResult(400, { error: "turnstile" });
	}
	const now = (deps.now ?? Date.now)();
	const blocked = await limited(request, input, env, memory, now);
	if (blocked) return blocked;
	return openIssue(env, input, deps);
}

async function readRecord(request: Request): Promise<Record<string, unknown> | "large" | "bad"> {
	const length = Number(request.headers.get("content-length") || 0);
	if (Number.isFinite(length) && length > BODY_MAX) return "large";
	const media = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (media === "application/x-www-form-urlencoded") {
		const text = await request.text();
		if (text.length > BODY_MAX) return "large";
		const form = new URLSearchParams(text);
		const record: Record<string, unknown> = {};
		for (const [key, value] of form.entries()) record[key] = value;
		return record;
	}
	if (media !== "application/json") return "bad";
	const text = await request.text();
	if (text.length > BODY_MAX) return "large";
	try {
		const parsed = JSON.parse(text) as unknown;
		return asRecord(parsed) ?? "bad";
	} catch {
		return "bad";
	}
}

function pageError(code: string): string {
	if (code === "rate_limit") return "rate_limit";
	if (code === "turnstile") return "turnstile";
	if (code === "timeout") return "timeout";
	if (code === "forbidden") return "origin";
	if (code === "invalid_message" || code === "invalid_kind" || code === "invalid_contact" || code === "invalid_agent" || code === "invalid_version" || code === "invalid_source") return "invalid";
	return "unavailable";
}

export function createFeedback(env: ControlEnv, deps: FeedbackDeps = {}) {
	const memory = new Map<string, number>();
	return {
		async api(request: Request): Promise<FeedbackResult> {
			if (!feedbackOn(env)) return jsonResult(404, { error: "not_found" });
			if (request.method !== "POST") return jsonResult(405, { error: "method" });
			const record = await readRecord(request);
			if (record === "large") return jsonResult(413, { error: "invalid_message" });
			if (record === "bad") return jsonResult(400, { error: "invalid_message" });
			const media = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
			if (media !== "application/json") return jsonResult(400, { error: "invalid_message" });
			const input = parseFeedback(record);
			if (typeof input === "string") return jsonResult(400, { error: input });
			return submitFeedback(request, env, input, record, memory, deps);
		},
		async page(request: Request, render: (input: { turnstileSiteKey?: string; error?: string; sent?: boolean; issueUrl?: string }) => string): Promise<FeedbackResult> {
			if (!feedbackOn(env)) return jsonResult(404, { error: "not_found" });
			const turnstile = turnstileOf(env);
			const url = new URL(request.url);
			if (request.method === "GET") {
				const issue = githubIssueUrl(feedbackRepo(env), url.searchParams.get("issue"));
				return {
					kind: "html",
					turnstile: Boolean(turnstile),
					html: render({
						turnstileSiteKey: turnstile?.siteKey,
						error: url.searchParams.get("error") ?? undefined,
						sent: url.searchParams.get("sent") === "1",
						issueUrl: issue || undefined,
					}),
				};
			}
			if (request.method !== "POST") return jsonResult(405, { error: "method" });
			const record = await readRecord(request);
			const back = (error: string) => {
				const next = new URL("/app/feedback", request.url);
				next.searchParams.set("error", pageError(error));
				return { kind: "redirect" as const, location: next.href };
			};
			if (record === "large" || record === "bad") return back("invalid_message");
			const input = parseFeedback({ ...record, source: "web" });
			if (typeof input === "string") return back(input);
			const result = await submitFeedback(request, env, input, record, memory, deps);
			if (result.kind !== "json") return result;
			if (result.status === 200 && result.body.ok === true) {
				const next = new URL("/app/feedback", request.url);
				next.searchParams.set("sent", "1");
				if (typeof result.body.issue_url === "string") next.searchParams.set("issue", result.body.issue_url);
				return { kind: "redirect", location: next.href };
			}
			const error = typeof result.body.error === "string" ? result.body.error : "unavailable";
			return back(error);
		},
	};
}
