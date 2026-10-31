// Shared local setup operations. No shell, token arguments, or child output.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CliError } from "./a2a.mjs";

export function writeTokenFile(file, token) {
	const dir = path.dirname(file);
	let tmp, fd;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		tmp = path.join(dir, `.a2a-token-${crypto.randomBytes(16).toString("hex")}`);
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, token + "\n");
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		fs.renameSync(tmp, file);
	} catch {
		throw new CliError("could not save the connector token; fix the destination permissions and retry setup; hosted finish needs fresh approval");
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
	}
}

function readPrivate(file) {
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024)
			throw new Error();
		return fs.readFileSync(fd, "utf8");
	} catch {
		throw new CliError("secret source must be a readable regular file with mode 600 (no symlinks, maximum 1 MiB)");
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function usableSecret(value) {
	if (typeof value !== "string" || !value.trim() || value === "INSECURE_NO_AUTH" || Buffer.byteLength(value) > 65536)
		throw new CliError("the selected source has no usable signing secret");
	return value;
}

export function validateSecretSource(o) {
	if (["secret-file", "secret-env", "secret-from"].filter((key) => o[key] !== undefined).length !== 1)
		throw new CliError("choose exactly one of --secret-file, --secret-env, or --secret-from hermes");
	if (o["secret-from"] !== undefined && o["secret-from"] !== "hermes")
		throw new CliError("the only secret adapter is hermes");
	if ((o["hermes-home"] || o.route) && o["secret-from"] !== "hermes")
		throw new CliError("--hermes-home and --route require --secret-from hermes");
	if (o["secret-env"] !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o["secret-env"]))
		throw new CliError("--secret-env must name an environment variable");
}

export function readSigningSecret(o, link, env = process.env) {
	validateSecretSource(o);
	if (o["secret-file"] !== undefined) return usableSecret(readPrivate(o["secret-file"]).replace(/\r?\n$/, ""));
	if (o["secret-env"] !== undefined) return usableSecret(env[o["secret-env"]]);
	if (link.preset !== "hermes") throw new CliError("the Hermes adapter requires the hermes preset");
	const match = /^\/webhooks\/([A-Za-z0-9_-]+)$/.exec(link.path);
	if (!match || (o.route && o.route !== match[1]))
		throw new CliError("Hermes route does not match the approved link path; select the exact route and Hermes home");
	const home = o["hermes-home"] || env.HERMES_HOME || path.join(os.homedir(), ".hermes");
	// Static YAML routes override dynamic subscriptions. Without a YAML dependency,
	// fail closed on any routes key; never guess which secret the gateway uses.
	try {
		const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
		if (/\broutes\b/.test(config)) throw new CliError("Hermes static routes may override this subscription; use --secret-file or --secret-env for the exact route secret");
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error.code !== "ENOENT") throw new CliError("could not check Hermes static route configuration");
	}
	let subscriptions;
	try { subscriptions = JSON.parse(readPrivate(path.join(home, "webhook_subscriptions.json")).replace(/^\uFEFF/, "")); }
	catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError("could not parse the Hermes subscriptions file");
	}
	const route = Object.hasOwn(subscriptions || {}, match[1]) ? subscriptions[match[1]] : null;
	if (!route || route.enabled === false) throw new CliError("the selected Hermes subscription is missing or disabled");
	return usableSecret(route.secret);
}

export const connectorArgs = (file) => ["tunnel", "run", "--token-file", file];
export const connectorCommand = (file) => "cloudflared " + connectorArgs(file).map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(" ");

export async function startConnector(file, spawnImpl = spawn) {
	let child;
	try {
		child = spawnImpl("cloudflared", connectorArgs(file), { detached: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"].includes(key))) });
		await new Promise((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
		child.unref();
		return child;
	} catch { throw new CliError("could not start cloudflared; install cloudflared and run finish again"); }
}
