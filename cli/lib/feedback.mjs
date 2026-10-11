// Feedback: post to a hosted control plane when this inbox points at one, otherwise print a GitHub issue link.
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

export function feedbackDocument({ message, kind, contact, version, agent, source = "cli" }) {
	const text = scrubFeedbackText(message).trim();
	const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const lines = [`Source: ${source}`, `Kind: ${kind}`];
	if (version) lines.push(`Version: ${scrubFeedbackText(version)}`);
	const who = agent ? scrubFeedbackText(agent).trim() : "";
	const reach = contact ? scrubFeedbackText(contact).trim() : "";
	if (who) lines.push(`Agent: ${who}`);
	if (reach) lines.push(`Contact: ${reach}`);
	lines.push("", text);
	return { title, body: lines.join("\n") };
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
	const doc = feedbackDocument({
		message: input.message, kind, contact: input.contact || "", version: input.version || "", agent: input.agent || "", source: "cli",
	});
	const fallback = () => ({ filed: false, url: feedbackIssueUrl(doc.title, doc.body) });
	const base = String(input.baseUrl || "").replace(/\/$/, "");
	const token = String(input.ownerToken || "");
	if (!base || !token) return fallback();
	const call = input.fetchImpl ?? fetch;
	let probe;
	try {
		probe = await call(`${base}/owner/feedback`, {
			headers: { accept: "application/json", authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		return fallback();
	}
	if (probe.status === 404) return fallback();
	const info = probe.ok ? await readJson(probe) : null;
	const endpoint = info?.hosted === true && feedbackUrlOk(info.url) ? info.url : "";
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
				message: scrubFeedbackText(input.message),
				kind,
				contact: scrubFeedbackText(input.contact || ""),
				source: "cli",
				agent: scrubFeedbackText(input.agent || ""),
				version: scrubFeedbackText(input.version || ""),
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
