// Bazel credential-helper protocol. Local lookup only; never discover or follow URLs.
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";
import { CliError } from "./a2a.mjs";

const recovery = "Inspect peers list --json in the selected --config-dir; select an ordinary outbound peer with its own token.";
const fail = (message) => { throw new CliError(`${message}. ${recovery}`); };

/** Match an exact endpoint or its two standard card URLs, never a host-wide scope. */
function endpoint(raw) {
	if (typeof raw !== "string" || raw.length > 8192 || /[\s\\%?#]/.test(raw)) return null;
	let u;
	try { u = new URL(raw); } catch { return null; }
	if (u.username || u.password || !u.hostname) return null;
	if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) return null;
	// URL parsing normalizes dot segments: refuse those rather than widening a credential's scope.
	if (/\/(?:\.{1,2})(?:\/|$)/.test(raw) || u.pathname.includes("//")) return null;
	return u.href.replace(/\/$/, "");
}

export function credentialFor(uri) {
	const target = endpoint(uri);
	if (!target) fail("credential get requires an HTTPS endpoint/card URI (HTTP is only allowed on loopback), without credentials, query or fragment");
	const peers = C.loadPeers();
	if (!peers || typeof peers !== "object" || Array.isArray(peers)) fail("Invalid local peer configuration");
	const matches = Object.values(peers).filter(pe => {
		const base = endpoint(pe?.url);
		return base && [base, `${base}/.well-known/agent-card.json`, `${base}/.well-known/agent.json`].includes(target);
	});
	if (matches.length !== 1) fail(matches.length ? "Ambiguous outbound peer URI" : "No outbound peer matches this exact URI");
	const peer = matches[0];
	if (fs.existsSync(path.join(C.CONFIG_DIR, "encryption/state.sqlite")) || Object.values(peers).some(pe => pe?.sealed))
		fail(`Local encrypted configuration requires ${C.CLI_COMMAND} send; a bearer helper cannot enforce encryption`);
	const key = peer.token_env;
	if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(A2A_|CONTROL_|WAKE_|UPSTREAM_|CF_|CLOUDFLARE_|APPROVAL_|EVENT_)/.test(key))
		fail("The outbound peer must reference a dedicated peer-token variable");
	const token = C.get(key);
	if (!token) fail("No token is configured for the matched outbound peer");
	if (typeof token !== "string" || token.startsWith("a2amcp_") || !/^[\x21-\x7e]{1,8192}$/.test(token) || ["A2A_OWNER_TOKEN", "CONTROL_TOKEN"].some(k => [process.env[k], C.fileConfig()[k]].filter(Boolean).includes(token)))
		fail("The matched outbound peer credential is not a valid dedicated bearer token");
	if (C.envOverridesFile(key)) console.error("warning: the matched peer's environment token overrides a different saved token; unset its token_env variable to use the saved token (see peers list --json)");
	return { headers: { Authorization: [`Bearer ${token}`] } };
}

async function readRequest() {
	if (process.stdin.isTTY) fail('credential get reads one JSON object {"uri":"https://peer.example.com"} from stdin');
	return new Promise((resolve, reject) => {
		let bytes = 0;
		const chunks = [];
		const finish = (error, value) => {
			clearTimeout(timer);
			process.stdin.removeListener("data", data);
			process.stdin.removeListener("end", end);
			process.stdin.removeListener("error", errorHandler);
			process.stdin.pause();
			error ? reject(new CliError(error)) : resolve(value);
		};
		const data = chunk => {
			bytes += chunk.length;
			if (bytes > 65536) return finish("credential get stdin exceeds 64 KiB; provide one JSON object with a uri");
			chunks.push(chunk);
		};
		const end = () => finish(null, Buffer.concat(chunks).toString("utf8"));
		const errorHandler = () => finish("credential get could not read stdin; provide one JSON object with a uri");
		const timer = setTimeout(() => finish("credential get needs a complete JSON object on stdin within 5 seconds; close stdin after writing it"), 5000);
		process.stdin.on("data", data).once("end", end).once("error", errorHandler);
	});
}

export async function credential(args) {
	if (args.length !== 1 || args[0] !== "get") throw new CliError('usage: a2a-exposed credential get (one JSON object with a uri on stdin); inspect peers list --json first');
	let request;
	try { request = JSON.parse(await readRequest()); }
	catch (e) {
		if (e instanceof CliError) throw e;
		throw new CliError('credential get needs one JSON object with a uri on stdin; input was not valid JSON');
	}
	if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.uri !== "string") fail("credential get stdin must be an object with a string uri");
	console.log(JSON.stringify(credentialFor(request.uri)));
}
