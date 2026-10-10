// Control-plane sign-in (RFC 8628). The CLI is a public client (`a2a-cli`).
// The session token is written to config.env and is never printed.
import * as C from "./config.mjs";
import { CLI, die } from "./a2a.mjs";

export const CLI_CLIENT_ID = "a2a-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** https origin with no userinfo, or "" when the value cannot be a control plane. */
export function controlOrigin(value) {
	const raw = String(value || "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		if (url.pathname !== "/" && url.pathname !== "") return "";
		if (url.search || url.hash) return "";
		return url.origin;
	} catch {
		return "";
	}
}

function scale() {
	const n = Number(process.env.A2A_POLL_SCALE);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}

async function readJson(response) {
	const text = await response.text();
	try { return text ? JSON.parse(text) : {}; } catch { return { error: "invalid_response" }; }
}

/**
 * Run the device flow and store CONTROL_URL plus CONTROL_TOKEN.
 * `fetchImpl` and `sleep` are for tests. The token is not included in the result.
 */
export async function deviceLogin({
	controlUrl,
	intent = "login",
	fetchImpl = fetch,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	write = (line) => console.error(line),
	save = (updates) => C.saveConfig(updates),
} = {}) {
	const origin = controlOrigin(controlUrl);
	if (!origin) die(`--control-url must be an https origin with no path (example: --control-url https://control.example)`);
	const codeResponse = await fetchImpl(`${origin}/api/auth/device/code`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ client_id: CLI_CLIENT_ID }),
	});
	const started = await readJson(codeResponse);
	if (!codeResponse.ok || !started.device_code || !started.user_code || !started.verification_uri_complete) {
		const reason = typeof started.error === "string" ? started.error : `HTTP ${codeResponse.status}`;
		die(reason === "not_found" || codeResponse.status === 404
			? `login is not turned on at ${origin}`
			: `could not start sign-in at ${origin} (${reason})`);
	}
	const verb = intent === "signup" ? "Create an account and approve" : "Sign in and approve";
	write(`${verb} this code:\n${started.user_code}\n${started.verification_uri_complete}`);
	const interval = Math.max(1, Number(started.interval) || 5);
	const deadline = Date.now() + Math.max(1, Number(started.expires_in) || 600) * 1000;
	let wait = interval;
	while (Date.now() < deadline) {
		await sleep(wait * 1000 * scale());
		const tokenResponse = await fetchImpl(`${origin}/api/auth/device/token`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: started.device_code, client_id: CLI_CLIENT_ID }),
		});
		const body = await readJson(tokenResponse);
		if (tokenResponse.ok && typeof body.access_token === "string" && body.access_token) {
			save({ CONTROL_URL: origin, CONTROL_TOKEN: body.access_token });
			const sessionResponse = await fetchImpl(`${origin}/api/auth/get-session`, {
				headers: { accept: "application/json", authorization: `Bearer ${body.access_token}` },
			});
			const session = await readJson(sessionResponse);
			const email = typeof session?.user?.email === "string" ? session.user.email : "";
			write(email ? `Signed in as ${email}.` : "Signed in.");
			return { controlUrl: origin, email };
		}
		const error = typeof body.error === "string" ? body.error : "";
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			wait += 5;
			continue;
		}
		if (error === "access_denied") die("sign-in was denied");
		if (error === "expired_token") die("that code expired; run the command again");
		die(`sign-in failed (${error || `HTTP ${tokenResponse.status}`})`);
	}
	die("that code expired; run the command again");
}
