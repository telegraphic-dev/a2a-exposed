// Feedback: post to a hosted control plane when this inbox points at one, otherwise print a GitHub issue link.
import os from "node:os";
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

/** Same shapes as the Worker's scrubSecretText, plus a Bearer value. */
export function scrubFeedbackText(value) {
	return String(value ?? "")
		.replace(TOKEN_RE, "[redacted]")
		.replace(SETUP_RE, "$1t=[redacted]")
		.replace(USERINFO_RE, "$1[redacted]@")
		.replace(BEARER_RE, "Bearer [redacted]");
}

export function feedbackIssueUrl(title, body) {
	const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
	url.searchParams.set("title", title);
	url.searchParams.set("body", body);
	return url.href;
}

const LIMIT = {
	message: 4000, steps: 4000, expected: 2000, actual: 2000, contact: 200,
	agent: 80, environment: 120, os: 80, node: 32, version: 80,
};
const BEFORE = [["steps", "Steps"], ["expected", "Expected"], ["actual", "Actual"], ["agent", "Agent"]];

function connectionPhrase(value) {
	if (value === "webhook") return "webhook wake";
	if (value === "proxy") return "proxy";
	if (value === "polling") return "polling";
	return "unknown";
}

function deploymentPhrase(value) {
	if (value === "hosted") return "hosted";
	if (value === "self-hosted" || value === "self-host") return "self-hosted";
	return "unknown";
}

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

function environmentBlock(input) {
	const version = scrubFeedbackText(input.version || "").trim();
	const where = scrubFeedbackText(input.environment || "").trim();
	const osName = scrubFeedbackText(input.os || "").trim();
	const node = scrubFeedbackText(input.node || "").trim();
	const lines = [
		`Deployment: ${deploymentPhrase(input.deployment || input.mode || "")}`,
		`Connection: ${connectionPhrase(input.connection || "")}`,
		`Version: ${version || "unknown"}`,
	];
	if (where) lines.push(`Where: ${where}`);
	if (osName) lines.push(`OS: ${osName}`);
	if (node) lines.push(`Node: ${node}`);
	return `## Environment\n\n${lines.join("\n")}`;
}

export function feedbackDocument(input) {
	const message = scrubFeedbackText(input.message).trim();
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${input.kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const parts = [[`Source: ${input.source || "cli"}`, `Kind: ${input.kind}`].join("\n"), `## What happened\n\n${message}`];
	for (const [key, heading] of BEFORE) {
		const text = scrubFeedbackText(input[key] || "").trim();
		if (text) parts.push(`## ${heading}\n\n${text}`);
	}
	parts.push(environmentBlock(input));
	const contact = scrubFeedbackText(input.contact || "").trim();
	if (contact) parts.push(`## Contact\n\n${contact}`);
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
	const fallback = () => ({ filed: false, url: feedbackIssueUrl(doc.title, doc.body) });
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
				environment: scrubFeedbackText(fields.environment),
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
