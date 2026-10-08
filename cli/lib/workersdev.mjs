// workers.dev support: URL helpers, cf output parsing, and registering the account's workers.dev subdomain
// through cf's own interactive prompt (cf has no non-interactive command for it).
import { spawn } from "node:child_process";
import { CliError, die } from "./a2a.mjs";

/** A valid DNS label: worker names and workers.dev subdomains must be one. */
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const DOCS = "https://developers.cloudflare.com/workers/configuration/routing/workers-dev/";
export const onboardingUrl = (accountId) => `https://dash.cloudflare.com/${accountId || "<account-id>"}/workers/onboarding`;

/** Base URL of a Worker: custom domain if set, else <worker>.<subdomain>.workers.dev, else "" (unknown yet). */
export function baseUrlFor({ hostname, worker, subdomain }) {
	if (hostname) return `https://${hostname}`;
	return subdomain ? `https://${worker}.${subdomain}.workers.dev` : "";
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]PX^_][^\x07\x1b]*(\x07|\x1b\\)/g, "");

/** The account's workers.dev subdomain, read from `cf deploy` output ("<worker>.<subdomain>.workers.dev"), or "". */
export function parseWorkersDevSubdomain(output, worker) {
	const esc = worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = stripAnsi(output).match(new RegExp(`(?:^|[^a-z0-9-])${esc}\\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.workers\\.dev\\b`, "i"));
	return m ? m[1].toLowerCase() : "";
}

/** cf refused to deploy because the account has no workers.dev subdomain yet. */
export const needsSubdomain = (output) => /register a workers\.dev subdomain/i.test(stripAnsi(output));

export function noSubdomainHelp(accountId) {
	return [
		"this Cloudflare account has no workers.dev subdomain yet. Create one (once per account), then re-run:",
		`  - let the CLI do it:   re-run with --workers-dev-subdomain <name>   (gives https://<worker>.<name>.workers.dev)`,
		`  - or in the dashboard: ${onboardingUrl(accountId)}  (the first visit to Workers & Pages asks for it)`,
		`  - or the API:          PUT /accounts/<account-id>/workers/subdomain  {"subdomain":"<name>"}`,
		`  docs: ${DOCS}`,
	].join("\n");
}

/** Prompt text with ANSI codes, whitespace and box-drawing glyphs removed, lowercased. Prompt libraries redraw
 *  with cursor moves and wrap to the terminal width (one character per line on a 0-column pty), so match on this. */
export const compactPrompt = (s) => stripAnsi(s).replace(/[\s\u2500-\u257f\u25a0-\u25ff]/g, "").toLowerCase();

/** cf's workers.dev registration prompts, in order, with the keys that answer them (matched on compactPrompt). */
export const REGISTRATION_STEPS = (name) => [
	[/registeraworkers\.devsubdomainnow\?/, "y"],
	[/whatwouldyoulikeyourworkers\.devsubdomaintobe\?/, `${name}\r`],
	[/oktoproceed\?/, "y"],
];
export const UNAVAILABLE_RE = /subdomainisunavailable/;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run `cf deploy` in a pseudo-terminal (via `script`) and answer cf's own workers.dev registration prompts:
 * "register a workers.dev subdomain now?" -> y, "what would you like your subdomain to be?" -> name, "Ok to proceed?" -> y.
 * Resolves { status, out }. Any other prompt is left unanswered and the run is stopped by the idle timeout.
 * Works with the logged-in cf session (OAuth or CLOUDFLARE_API_TOKEN); needs a Unix `script` (Linux, macOS).
 */
export function deployWithRegistration(cfBin, args, name, { cwd, env, idleMs = 180000 } = {}) {
	if (process.platform === "win32") die(`registering a workers.dev subdomain from the CLI needs a Unix 'script' command; use the dashboard instead.\n${noSubdomainHelp(env?.CLOUDFLARE_ACCOUNT_ID)}`);
	// give the pty a real size: `script` under a pipe starts with 0 columns, and cf's prompts then wrap per character
	const cmd = `stty cols 160 rows 50 2>/dev/null; exec ${[cfBin, ...args].map(shq).join(" ")}`;
	const sargs = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", cmd] : ["-qec", cmd, "/dev/null"];
	const penv = { ...env, TERM: env?.TERM || "xterm-256color", COLUMNS: "160", LINES: "50" };
	delete penv.CI; // cf only prompts when interactive
	return new Promise((resolve, reject) => {
		const ch = spawn("script", sargs, { cwd, env: penv, stdio: ["pipe", "pipe", "pipe"] });
		// cf's prompts, in order; each is answered once, and only from output that arrived after the previous
		// answer (prompt libraries re-render answered questions, which must not be answered twice)
		const steps = REGISTRATION_STEPS(name);
		let out = "", pending = "", stage = 0, failure = "";
		const stop = (why) => { failure ||= why; ch.kill("SIGTERM"); };
		const arm = () => setTimeout(() => stop("cf stopped responding (unexpected prompt?)"), idleMs);
		let idle = arm();
		const onData = (d) => {
			process.stderr.write(d);
			out += d; pending += d;
			clearTimeout(idle); idle = arm();
			const p = compactPrompt(pending);
			if (UNAVAILABLE_RE.test(p)) return stop(`workers.dev subdomain "${name}" is unavailable; pick another name`);
			if (stage < steps.length && steps[stage][0].test(p)) {
				pending = "";
				ch.stdin.write(steps[stage++][1]);
			}
		};
		ch.stdout.on("data", onData);
		ch.stderr.on("data", onData);
		ch.on("error", (e) => { clearTimeout(idle); reject(e); });
		ch.on("close", (code) => {
			clearTimeout(idle);
			ch.stdin.destroy();
			if (failure) return reject(new CliError(failure));
			resolve({ status: code ?? 1, out });
		});
	});
}
