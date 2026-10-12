// POST /api/feedback files a GitHub issue when FEEDBACK_REPO is set and either the GitHub App
// (FEEDBACK_GITHUB_APP_ID and FEEDBACK_GITHUB_APP_PRIVATE_KEY) or FEEDBACK_GITHUB_TOKEN is set.
// Neither credential, or no valid repo, is 404, so a self-hosted control plane is unchanged.
// The app is preferred when both are set. The token is the self-host fallback.
// None of these names use the GITHUB_* prefix: that prefix is the sign-in OAuth app.
import { connectingIp, verifyTurnstile, type TurnstileFailure } from "./auth/turnstile.ts";
import { sameOrigin } from "./auth/origin.ts";
import type { Sql } from "./auth/invites.ts";
import type { ControlEnv } from "./env.ts";
import { feedbackAppReady, feedbackPat, githubAccessToken, type GithubTokenCache } from "./feedback-app.ts";

export const MESSAGE_MAX = 4000;
export const PER_HOUR = 5;
export const GITHUB_TIMEOUT_MS = 5000;
const WINDOW_MS = 60 * 60 * 1000;
const BODY_MAX = 32_000;
const CONTACT_MAX = 200;
const AGENT_MAX = 80;
const STEPS_MAX = 4000;
const LOGS_MAX = 4000;
const DETAIL_MAX = 2000;
const ENVIRONMENT_MAX = 120;
const OS_MAX = 80;
const NODE_MAX = 32;
const VERSION_RE = /^[A-Za-z0-9._+();: -]{1,80}$/;
const NODE_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const DEPLOYMENTS = ["hosted", "self-hosted"] as const;
const CONNECTIONS = ["webhook", "proxy", "polling"] as const;
const ENVIRONMENTS = ["local", "cloud VM", "CI", "cloud agent sandbox", "other"] as const;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KINDS = ["bug", "idea", "other"] as const;
const SOURCES = ["web", "cli", "mcp"] as const;

type Kind = (typeof KINDS)[number];
type Source = (typeof SOURCES)[number];

/** Same token shapes as the Worker's scrubSecretText, plus a Bearer value, a PEM private key, and common API-key prefixes. */
const TOKEN_RE = /(?:a2aow_|s2a_|a2amcp_|a2amcpr_|a2aot_)[A-Za-z0-9_-]{20,}/g;
const SETUP_RE = /([?&])t=[A-Za-z0-9_-]{16,}/g;
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?\s]*@/gi;
const BEARER_RE = /bearer\s+\S{8,200}/gi;
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g;
const API_KEY_RE = /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\brk_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b)/g;

export interface FeedbackDeps {
	fetch?: typeof fetch;
	now?: () => number;
	githubTimeoutMs?: number;
	githubCache?: GithubTokenCache;
}

export interface FeedbackInput {
	message: string;
	kind: Kind;
	contact: string;
	source: Source;
	agent: string;
	version: string;
	steps: string;
	expected: string;
	actual: string;
	environment: string;
	os: string;
	node: string;
	connection: string;
	deployment: string;
	logs: string;
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
	return Boolean(feedbackRepo(env) && (feedbackAppReady(env) || feedbackPat(env)));
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
		.replace(BEARER_RE, "Bearer [redacted]")
		.replace(PEM_RE, "[redacted]")
		.replace(API_KEY_RE, "[redacted]");
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(value: string, max: number): string {
	const clean = scrubFeedbackText(value.replace(/\u0000/g, "")).trim();
	return clean.length > max ? clean.slice(0, max) : clean;
}

/** Headings match the `label` of each field in `.github/ISSUE_TEMPLATE/bug_report.yml`. */
const FORM_FIELDS: [keyof FeedbackInput, string, number, boolean][] = [
	["message", "What happened", MESSAGE_MAX, true],
	["version", "a2a-exposed version", 80, true],
	["connection", "Connection type", 16, true],
	["deployment", "Deployment", 16, true],
	["agent", "Agent", AGENT_MAX, false],
	["environment", "Environment", ENVIRONMENT_MAX, false],
	["steps", "Reproduction steps", STEPS_MAX, false],
	["expected", "Expected", DETAIL_MAX, false],
	["actual", "Actual", DETAIL_MAX, false],
	["logs", "Logs", LOGS_MAX, false],
	["os", "OS", OS_MAX, false],
	["node", "Node", NODE_MAX, false],
	["contact", "Contact", CONTACT_MAX, false],
];

/** Proxy when an upstream is set, webhook when a wake URL is set, otherwise polling. The URLs stay out of the result. */
export function inboxConnection(config: Record<string, string>): (typeof CONNECTIONS)[number] {
	const upstream = (config.UPSTREAM_URL ?? "").trim().toLowerCase();
	if (upstream && upstream !== "none" && upstream !== "off") return "proxy";
	if ((config.WAKE_WEBHOOK_URL ?? "").trim()) return "webhook";
	return "polling";
}

function connectionText(value: string): string {
	if (value === "webhook" || value === "proxy" || value === "polling") return value;
	return "unknown";
}

function deploymentText(value: string): string {
	if (value === "hosted") return "hosted";
	if (value === "self-hosted" || value === "self-host") return "self-hosted";
	return "unknown";
}

/** Dropdown options from the bug report form. Older phrases map onto those options. */
function environmentValue(value: string): string {
	const text = value.trim();
	if ((ENVIRONMENTS as readonly string[]).includes(text)) return text;
	const aliases: Record<string, string> = { "local laptop": "local", "cloud vm/vps": "cloud VM" };
	return aliases[text.toLowerCase()] || text;
}

function secretList(token: string | readonly string[]): string[] {
	const list = typeof token === "string" ? [token] : token;
	return list.filter((item) => item.length >= 8);
}

function clean(value: string, max: number, secrets: readonly string[]): string {
	let text = clip(value, max);
	for (const secret of secrets) text = text.split(secret).join("[redacted]");
	return text;
}

function formValue(input: FeedbackInput, key: keyof FeedbackInput, secrets: readonly string[], max: number): string {
	if (key === "connection") return connectionText(input.connection);
	if (key === "deployment") return deploymentText(input.deployment);
	if (key === "version") return clean(input.version || "", max, secrets) || "unknown";
	if (key === "environment") return environmentValue(clean(input.environment || "", max, secrets));
	return clean(input[key] || "", max, secrets);
}

/** The same labels as the GitHub form for this kind, plus `from-agent` when an agent filed it. */
function issueLabels(input: FeedbackInput): string[] {
	const labels = input.kind === "bug" ? ["bug", "feedback"] : input.kind === "idea" ? ["enhancement", "feedback"] : ["feedback"];
	if (input.source === "cli" || input.source === "mcp") labels.push("from-agent");
	return labels;
}

export function issueDocument(input: FeedbackInput, token: string | readonly string[]): { title: string; body: string; labels: string[] } {
	const secrets = secretList(token);
	const message = clean(input.message, MESSAGE_MAX, secrets);
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${input.kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const parts: string[] = [];
	for (const [key, heading, max, always] of FORM_FIELDS) {
		const text = formValue(input, key, secrets, max);
		if (!text && !always) continue;
		parts.push(`### ${heading}\n\n${escapeText(text || "unknown")}`);
	}
	return { title, body: parts.join("\n\n"), labels: issueLabels(input) };
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
	if (contact.length > CONTACT_MAX || /[\n\r]/.test(contact)) return "invalid_contact";
	const agent = field(record, "agent");
	if (agent.length > AGENT_MAX || /[\n\r]/.test(agent)) return "invalid_agent";
	const version = field(record, "version");
	if (version && !VERSION_RE.test(version)) return "invalid_version";
	const steps = field(record, "steps");
	if (steps.length > STEPS_MAX) return "invalid_steps";
	if ((kind as Kind) === "bug" && !steps.trim()) return "steps_required";
	const logs = field(record, "logs");
	if (logs.length > LOGS_MAX) return "invalid_logs";
	const expected = field(record, "expected");
	if (expected.length > DETAIL_MAX) return "invalid_expected";
	const actual = field(record, "actual");
	if (actual.length > DETAIL_MAX) return "invalid_actual";
	const environment = field(record, "environment");
	if (environment.length > ENVIRONMENT_MAX || /[\n\r]/.test(environment)) return "invalid_environment";
	const os = field(record, "os");
	if (os.length > OS_MAX || /[\n\r]/.test(os)) return "invalid_os";
	const node = field(record, "node");
	if (node && !NODE_RE.test(node)) return "invalid_node";
	const connection = field(record, "connection");
	if (connection && !CONNECTIONS.includes(connection as (typeof CONNECTIONS)[number])) return "invalid_connection";
	const named = deploymentValue(field(record, "deployment"));
	if (named === null) return "invalid_deployment";
	const alias = deploymentValue(field(record, "mode"));
	if (alias === null) return "invalid_mode";
	return {
		message, kind: kind as Kind, contact, source: source as Source, agent, version,
		steps, expected, actual, environment: environmentValue(environment), os, node, logs,
		connection, deployment: named || alias,
	};
}

/** Empty stays empty. `self-host` is the older spelling of self-hosted. Anything else is rejected. */
function deploymentValue(value: string): string | null {
	if (!value) return "";
	if (value === "self-host") return "self-hosted";
	if (DEPLOYMENTS.includes(value as (typeof DEPLOYMENTS)[number])) return value;
	return null;
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

function githubFailure(error: unknown, source: string): FeedbackResult {
	const name = error instanceof Error ? error.name : "";
	const timeoutHit = name === "TimeoutError" || name === "AbortError";
	console.error(JSON.stringify({ event: "feedback_failed", source, status: 0, error: timeoutHit ? "timeout" : "fetch" }));
	return jsonResult(timeoutHit ? 504 : 502, { error: timeoutHit ? "timeout" : "unavailable" });
}

async function openIssue(env: ControlEnv, input: FeedbackInput, deps: FeedbackDeps): Promise<FeedbackResult> {
	const repo = feedbackRepo(env);
	const timeout = deps.githubTimeoutMs ?? GITHUB_TIMEOUT_MS;
	const call = deps.fetch ?? fetch;
	let token = "";
	let doc: ReturnType<typeof issueDocument>;
	try {
		const access = await githubAccessToken(env, repo, deps);
		token = access.token;
		doc = issueDocument(input, access.secrets);
	} catch (error) {
		return githubFailure(error, input.source);
	}
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
		return githubFailure(error, input.source);
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
	if (code === "steps_required") return "steps";
	if (code.startsWith("invalid")) return "invalid";
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
		async page(request: Request, render: (input: { turnstileSiteKey?: string; error?: string; sent?: boolean; issueUrl?: string; connection?: string; deployment?: string; repo?: string }) => string): Promise<FeedbackResult> {
			if (!feedbackOn(env)) return jsonResult(404, { error: "not_found" });
			const turnstile = turnstileOf(env);
			const url = new URL(request.url);
			if (request.method === "GET") {
				const issue = githubIssueUrl(feedbackRepo(env), url.searchParams.get("issue"));
				const connection = url.searchParams.get("connection") ?? "";
				const deployment = url.searchParams.get("deployment") ?? "";
				return {
					kind: "html",
					turnstile: Boolean(turnstile),
					html: render({
						turnstileSiteKey: turnstile?.siteKey,
						error: url.searchParams.get("error") ?? undefined,
						sent: url.searchParams.get("sent") === "1",
						issueUrl: issue || undefined,
						connection: CONNECTIONS.includes(connection as (typeof CONNECTIONS)[number]) ? connection : "",
						deployment: DEPLOYMENTS.includes(deployment as (typeof DEPLOYMENTS)[number]) ? deployment : "",
						repo: feedbackRepo(env),
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
