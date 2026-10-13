// Feedback: post when this inbox names a feedback URL, otherwise print a GitHub issue link.
import os from "node:os";
import readline from "node:readline/promises";
import { CliError } from "./a2a.mjs";
import * as C from "./config.mjs";

export const ISSUE_REPO = "telegraphic-dev/a2a-exposed";
export const STAR_LINE = "Like it? Star us: https://github.com/telegraphic-dev/a2a-exposed";
export const KINDS = ["bug", "idea", "other"];
export const CONNECTIONS = ["webhook", "proxy", "polling"];

const TOKEN_RE = /(?:a2aow_|s2a_|a2amcp_|a2amcpr_|a2aot_)[A-Za-z0-9_-]{20,}/g;
const SETUP_RE = /([?&])t=[A-Za-z0-9_-]{16,}/g;
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?\s]*@/gi;
const BEARER_RE = /bearer\s+\S{8,200}/gi;
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g;
const API_KEY_RE = /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\brk_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b)/g;

/** Same shapes as the Worker's scrubSecretText, plus a Bearer value, a PEM private key, and common API-key prefixes. */
export function scrubFeedbackText(value) {
	return String(value ?? "")
		.replace(TOKEN_RE, "[redacted]")
		.replace(SETUP_RE, "$1t=[redacted]")
		.replace(USERINFO_RE, "$1[redacted]@")
		.replace(BEARER_RE, "Bearer [redacted]")
		.replace(PEM_RE, "[redacted]")
		.replace(API_KEY_RE, "[redacted]");
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The repository that will receive the issue. The prefilled form is ISSUE_REPO. A hosted post uses the name that URL returns. */
export function publicIssueWarning(repo = ISSUE_REPO) {
	const name = typeof repo === "string" && REPO_RE.test(repo) && repo.length <= 100 && !repo.includes("..") ? repo : ISSUE_REPO;
	return `This report is filed as a public GitHub issue on ${name}. Do not include confidential information: secrets, tokens, owner or pairing tokens, private URLs or hostnames, message contents, or personal data.`;
}

export const PUBLIC_ISSUE_WARNING = publicIssueWarning(ISSUE_REPO);

/** Print the public-issue warning. On a terminal, wait for y or yes unless `yes` is set. Off a terminal, `--yes` is required. */
export async function confirmPublicIssue(yes, input = process.stdin, output = process.stderr, repo = ISSUE_REPO) {
	output.write(`${publicIssueWarning(repo)}\n`);
	if (yes) return;
	if (!input.isTTY) throw new CliError("feedback files a public GitHub issue; pass --yes to send it");
	const rl = readline.createInterface({ input, output });
	try {
		const answer = (await rl.question("File this public issue? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") throw new CliError("feedback not sent");
	} finally {
		rl.close();
	}
}

const ENVIRONMENTS = ["local", "cloud VM", "CI", "cloud agent sandbox", "other"];
const FORM_FIELDS = [
	["message", "What happened", true],
	["version", "a2a-exposed version", true],
	["connection", "Connection type", true],
	["deployment", "Deployment", true],
	["agent", "Agent", false],
	["environment", "Environment", false],
	["steps", "Reproduction steps", false],
	["expected", "Expected", false],
	["actual", "Actual", false],
	["logs", "Logs", false],
	["os", "OS", false],
	["node", "Node", false],
	["contact", "Contact", false],
];

function environmentValue(value) {
	const text = String(value || "").trim();
	if (ENVIRONMENTS.includes(text)) return text;
	const aliases = { "local laptop": "local", "cloud vm/vps": "cloud VM" };
	return aliases[text.toLowerCase()] || text;
}

function connectionText(value) {
	return CONNECTIONS.includes(value) ? value : "unknown";
}

function deploymentText(value) {
	if (value === "hosted") return "hosted";
	if (value === "self-hosted" || value === "self-host") return "self-hosted";
	return "unknown";
}

/** Prefill the bug report form. Query names are the form field ids. Dropdowns are set only when the value is one of their options. */
export function feedbackIssueUrl(input) {
	const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
	url.searchParams.set("template", "bug_report.yml");
	if (input.title) url.searchParams.set("title", input.title);
	let message = String(input.message || "").trim();
	const environment = environmentValue(input.environment);
	if (environment && !ENVIRONMENTS.includes(environment)) message = `${message}\n\nEnvironment: ${environment}`.trim();
	const values = {
		...input,
		message,
		environment: ENVIRONMENTS.includes(environment) ? environment : "",
		connection: CONNECTIONS.includes(input.connection) ? input.connection : "",
		deployment: input.deployment === "hosted" || input.deployment === "self-hosted" ? input.deployment : "",
	};
	for (const id of ["message", "version", "connection", "deployment", "agent", "environment", "steps", "expected", "actual", "logs", "os", "node", "contact"]) {
		const value = String(values[id] || "").trim();
		if (value && value !== "unknown") url.searchParams.set(id, value);
	}
	return url.href;
}

const LIMIT = {
	message: 4000, steps: 4000, expected: 2000, actual: 2000, logs: 4000, contact: 200,
	agent: 80, environment: 120, os: 80, node: 32, version: 80,
};

/** Proxy when A2A_UPSTREAM_URL is set, webhook when WAKE_WEBHOOK_URL is set, otherwise polling. The URLs stay out of the result. */
export function localConnection() {
	const upstream = String(C.get("A2A_UPSTREAM_URL") || "").trim().toLowerCase();
	if (upstream && upstream !== "none" && upstream !== "off") return "proxy";
	if (String(C.get("WAKE_WEBHOOK_URL") || "").trim()) return "webhook";
	return "polling";
}

/** OS and Node are filled in by the CLI. Connection and deployment are filled once the inbox answers, or from local config. */
export function localFacts() {
	const raw = `${os.platform()} ${os.release()}`.replace(/[^\w .()+_-]/g, " ").replace(/\s+/g, " ").trim();
	return { os: raw.slice(0, LIMIT.os), node: process.version.slice(0, LIMIT.node) };
}

function formText(input, key) {
	if (key === "connection") return connectionText(input.connection);
	if (key === "deployment") return deploymentText(input.deployment || input.mode);
	if (key === "version") return scrubFeedbackText(input.version || "").trim() || "unknown";
	if (key === "environment") return environmentValue(scrubFeedbackText(input.environment || "").trim());
	return scrubFeedbackText(input[key] || "").trim();
}

export function feedbackDocument(input) {
	const message = scrubFeedbackText(input.message).trim();
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${input.kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const parts = [];
	for (const [key, heading, always] of FORM_FIELDS) {
		const text = formText(input, key);
		if (!text && !always) continue;
		parts.push(`### ${heading}\n\n${text || "unknown"}`);
	}
	return { title, body: parts.join("\n\n") };
}

function workerVersion(value) {
	const text = String(value || "").trim();
	return /^[A-Za-z0-9._+-]{1,32}$/.test(text) ? text : "";
}

function withWorker(cli, worker) {
	if (!worker) return cli;
	const mark = `(worker ${worker})`;
	if (String(cli).includes(mark)) return String(cli).slice(0, LIMIT.version);
	const combined = cli ? `${cli} ${mark}` : `worker ${worker}`;
	return combined.slice(0, LIMIT.version);
}

/** One dim line on a terminal. Piped stderr stays plain so tests can match the sentence. */
export function printStar() {
	const line = process.stderr.isTTY ? `\x1b[2m${STAR_LINE}\x1b[0m` : STAR_LINE;
	console.error(line);
}

function feedbackUrlOk(value) {
	if (typeof value !== "string" || value.length > 300) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/api/feedback" && !url.search && !url.hash;
	} catch {
		return false;
	}
}

function githubIssue(value) {
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

async function readJson(response) {
	try { return await response.json(); } catch { return null; }
}

function namedRepo(value) {
	const repo = typeof value === "string" ? value.trim() : "";
	if (!REPO_RE.test(repo) || repo.length > 100 || repo.includes("..")) return "";
	return repo;
}

/**
 * Repository named in the warning before a report is sent.
 * No hosted endpoint: the prefilled form on ISSUE_REPO.
 * Hosted: GET /api/feedback must return `{ repo }`. A missing name does not guess ISSUE_REPO.
 */
export async function feedbackPublicRepo(input) {
	const base = String(input.baseUrl || "").replace(/\/$/, "");
	const token = String(input.ownerToken || "");
	const call = input.fetchImpl ?? fetch;
	if (!base || !token) return ISSUE_REPO;
	let probe;
	try {
		probe = await call(`${base}/owner/feedback`, {
			headers: { accept: "application/json", authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		probe = null;
	}
	const info = probe && probe.ok ? await readJson(probe) : null;
	if (!info || info.hosted !== true || !feedbackUrlOk(info.url)) return ISSUE_REPO;
	let named;
	try {
		named = await call(info.url, {
			method: "GET",
			headers: { accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		named = null;
	}
	const body = named && named.ok ? await readJson(named) : null;
	const repo = namedRepo(body?.repo);
	if (!repo) throw new CliError("the inbox did not name the public repository; feedback was not sent");
	return repo;
}

/**
 * Post when GET /owner/feedback says this inbox is hosted and names an https /api/feedback URL.
 * A missing inbox, a probe failure, or a 404 prints the prefilled issue URL. 400, 429, and 5xx throw.
 * @param {{ message: string, kind: string, contact?: string, version?: string, agent?: string, connection?: string, baseUrl?: string, ownerToken?: string, fetchImpl?: typeof fetch }} input
 */
export async function runFeedback(input) {
	const kind = input.kind || "other";
	const facts = localFacts();
	const chosen = String(input.connection || "");
	if (chosen && !CONNECTIONS.includes(chosen)) throw new CliError("--connection must be webhook, proxy, or polling");
	const fields = {
		message: String(input.message ?? ""),
		kind,
		contact: input.contact || "",
		steps: input.steps || "",
		expected: input.expected || "",
		actual: input.actual || "",
		logs: input.logs || "",
		agent: input.agent || "",
		environment: input.environment || "",
		os: input.os || facts.os,
		node: input.node || facts.node,
		version: input.version || "",
		connection: chosen,
		deployment: "",
		source: "cli",
	};
	for (const [key, max] of Object.entries(LIMIT)) {
		if (String(fields[key] ?? "").length > max) throw new CliError(`${key} is too long`);
	}
	if (kind === "bug" && !String(fields.steps).trim()) throw new CliError("a bug report needs reproduction steps (--steps)");
	const base = String(input.baseUrl || "").replace(/\/$/, "");
	const token = String(input.ownerToken || "");
	const call = input.fetchImpl ?? fetch;
	let endpoint = "";
	if (base && token) {
		let probe;
		try {
			probe = await call(`${base}/owner/feedback`, {
				headers: { accept: "application/json", authorization: `Bearer ${token}` },
				redirect: "error",
				signal: AbortSignal.timeout(5000),
			});
		} catch {
			probe = null;
		}
		if (probe && probe.status !== 404) {
			const info = probe.ok ? await readJson(probe) : null;
			if (info?.hosted === true) {
				fields.deployment = "hosted";
				if (feedbackUrlOk(info.url)) endpoint = info.url;
			} else if (info && info.hosted === false) fields.deployment = "self-hosted";
			if (!fields.connection && CONNECTIONS.includes(info?.connection)) fields.connection = info.connection;
			const worker = workerVersion(info?.version);
			if (worker) fields.version = withWorker(fields.version, worker);
		}
	} else fields.deployment = "self-hosted";
	if (!fields.connection) fields.connection = localConnection();
	const doc = feedbackDocument(fields);
	const fallback = () => ({
		filed: false,
		url: feedbackIssueUrl({
			title: doc.title,
			message: scrubFeedbackText(fields.message),
			version: scrubFeedbackText(fields.version),
			connection: fields.connection,
			deployment: fields.deployment,
			agent: scrubFeedbackText(fields.agent),
			environment: environmentValue(scrubFeedbackText(fields.environment)),
			steps: scrubFeedbackText(fields.steps),
			expected: scrubFeedbackText(fields.expected),
			actual: scrubFeedbackText(fields.actual),
			logs: scrubFeedbackText(fields.logs),
			os: scrubFeedbackText(fields.os),
			node: scrubFeedbackText(fields.node),
			contact: scrubFeedbackText(fields.contact),
		}),
	});
	if (!endpoint) return fallback();
	let response;
	try {
		response = await call(endpoint, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				message: scrubFeedbackText(fields.message),
				kind,
				contact: scrubFeedbackText(fields.contact),
				source: "cli",
				agent: scrubFeedbackText(fields.agent),
				version: scrubFeedbackText(fields.version),
				steps: scrubFeedbackText(fields.steps),
				expected: scrubFeedbackText(fields.expected),
				actual: scrubFeedbackText(fields.actual),
				logs: scrubFeedbackText(fields.logs),
				environment: environmentValue(scrubFeedbackText(fields.environment)),
				os: scrubFeedbackText(fields.os),
				node: scrubFeedbackText(fields.node),
				mode: fields.deployment,
				deployment: fields.deployment,
				connection: fields.connection,
			}),
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		throw new CliError(`feedback request failed: ${error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unavailable"}`);
	}
	if (response.status === 404) return fallback();
	const data = await readJson(response);
	if (response.ok) {
		const issue = githubIssue(data?.issue_url);
		if (issue) return { filed: true, url: issue };
		throw new CliError("feedback could not be filed");
	}
	if (response.status === 429) throw new CliError("too many feedback reports; try again later");
	if (response.status === 400) throw new CliError("feedback rejected");
	throw new CliError("feedback could not be filed");
}
