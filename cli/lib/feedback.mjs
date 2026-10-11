// Feedback: post to a hosted control plane when this inbox points at one, otherwise print a GitHub issue link.
import os from "node:os";
import { CliError } from "./a2a.mjs";

export const ISSUE_REPO = "telegraphic-dev/a2a-exposed";
export const STAR_LINE = "Like it? Star us: https://github.com/telegraphic-dev/a2a-exposed";
export const KINDS = ["bug", "idea", "other"];

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
	agent: 80, environment: 120, os: 80, node: 32, version: 64,
};
const SECTIONS = [
	["steps", "Steps"], ["expected", "Expected"], ["actual", "Actual"], ["agent", "Agent"],
	["environment", "Environment"], ["os", "OS"], ["node", "Node"], ["mode", "Mode"], ["contact", "Contact"],
];

/** OS and Node are filled in by the CLI. Mode is hosted or self-host once the inbox answers. */
export function localFacts() {
	const raw = `${os.platform()} ${os.release()}`.replace(/[^\w .()+_-]/g, " ").replace(/\s+/g, " ").trim();
	return { os: raw.slice(0, LIMIT.os), node: process.version.slice(0, LIMIT.node) };
}

export function feedbackDocument(input) {
	const message = scrubFeedbackText(input.message).trim();
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${input.kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const head = [`Source: ${input.source || "cli"}`, `Kind: ${input.kind}`];
	if (input.version) head.push(`Version: ${scrubFeedbackText(input.version)}`);
	const parts = [head.join("\n"), `## What happened\n\n${message}`];
	for (const [key, heading] of SECTIONS) {
		const text = scrubFeedbackText(input[key] || "").trim();
		if (text) parts.push(`## ${heading}\n\n${text}`);
	}
	return { title, body: parts.join("\n\n") };
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
 * @param {{ message: string, kind: string, contact?: string, version?: string, agent?: string, baseUrl?: string, ownerToken?: string, fetchImpl?: typeof fetch }} input
 */
export async function runFeedback(input) {
	const kind = input.kind || "other";
	const facts = localFacts();
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
		mode: input.mode || "",
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
				if (!fields.mode) fields.mode = "hosted";
				if (feedbackUrlOk(info.url)) endpoint = info.url;
			} else if (info && info.hosted === false && !fields.mode) fields.mode = "self-host";
		}
	} else if (!fields.mode) fields.mode = "self-host";
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
				mode: fields.mode,
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
