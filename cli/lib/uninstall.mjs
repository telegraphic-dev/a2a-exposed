// `uninstall`: remove the Worker, the wake tunnel (when one is saved), and the D1 database for this config.
import readline from "node:readline/promises";
import { CLI, CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as D from "./deploy.mjs";
import * as T from "./tunnel.mjs";

const step = (s) => console.error(`==> ${s}`);

/** Saved Worker, D1 id, or tunnel: something this config deployed. */
export function deploymentSaved() {
	return !!(C.get("A2A_WORKER_NAME") || C.get("A2A_D1_ID") || T.TUNNEL_KEYS.some((k) => C.get(k)));
}

/** Lines printed before the prompt and by `--dry-run`. The wake line is present only when a tunnel is saved. */
export function uninstallPlan() {
	const lines = ["This removes:"];
	lines.push(`Worker: ${C.get("A2A_WORKER_NAME") || "(none saved)"}`);
	const d1 = [C.get("A2A_D1_NAME"), C.get("A2A_D1_ID")].filter(Boolean).join(" ");
	lines.push(`D1: ${d1 || "(none saved)"}`);
	lines.push(`Account: ${C.get("CLOUDFLARE_ACCOUNT_ID") || "(none saved)"}`);
	if (T.TUNNEL_KEYS.some((k) => C.get(k))) {
		const host = C.get("A2A_TUNNEL_HOSTNAME");
		const id = C.get("A2A_TUNNEL_ID");
		const worker = C.get("A2A_WORKER_NAME");
		const label = worker ? `a2a-exposed wake ${worker}` : "(none saved)";
		lines.push(`Wake: ${[host, id && `tunnel ${id}`].filter(Boolean).join(", ") || "(tunnel saved)"}`);
		const app = C.get("A2A_TUNNEL_ACCESS_APP_ID");
		const token = C.get("A2A_TUNNEL_ACCESS_TOKEN_ID");
		const dns = C.get("A2A_TUNNEL_DNS_ID");
		lines.push(`Access application: ${app ? `${label} (${app})` : "(none saved)"}`);
		lines.push(`Service token: ${token ? `${label} (${token})` : "(none saved)"}`);
		lines.push(`DNS record: ${[host, dns && `id ${dns}`].filter(Boolean).join(", ") || "(none saved)"}`);
	}
	lines.push("Removal is permanent. It takes the messages and the paired peers with it.");
	return lines.join("\n");
}

/** Ask before deleting. On a terminal, wait for y or yes unless `yes` is set. Off a terminal, `--yes` is required. */
export async function confirmUninstall(yes, input = process.stdin, output = process.stderr) {
	if (yes) return;
	if (!input.isTTY) throw new CliError("uninstall removes the Worker, the D1 database, and the wake tunnel. Pass --yes.");
	const rl = readline.createInterface({ input, output });
	try {
		const answer = (await rl.question("Remove the Worker, D1 database and wake tunnel listed above? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") throw new CliError("uninstall cancelled");
	} finally {
		rl.close();
	}
}

const kept = () => `Config directory kept at ${C.CONFIG_DIR}. The owner token and WAKE_* values stay in config.env. A later init reuses the owner token. Peer tokens stay in this directory too. Remove the directory to delete them.`;

/** [10000] / [7403], and a D1 failure after the Worker is gone, say how to continue. */
function removalError(err, { removed, left, workerGone }) {
	const msg = err instanceof Error ? err.message : String(err);
	const code = /\[(10000|7403)\]/.test(msg);
	const d1Failed = /cf d1 delete/i.test(msg);
	const dnsFailed = /DNS record/i.test(msg);
	const workerPerm = /\[10000\]/.test(msg) && /cf workers delete/i.test(msg);
	if (!code && !(d1Failed && workerGone) && !dnsFailed) throw err instanceof CliError ? err : new CliError(msg);
	const lines = [msg];
	if (!/uninstall --yes/.test(msg))
		lines.push(`Run \`${CLI} uninstall --yes\` again. A rerun continues from what is left.`);
	lines.push(`Removed: ${removed.length ? removed.join("; ") : "nothing"}.`);
	lines.push(`Not removed: ${left.length ? left.join("; ") : "nothing"}.`);
	if (d1Failed && workerGone) lines.push("The Worker is already gone. A rerun removes the D1 database.");
	if (workerPerm) lines.push("A Cloudflare 10000 on the Worker delete still removes the other objects. A rerun is safe.");
	throw new CliError(lines.join("\n"));
}

/** One line per removal. A missing Worker or D1 counts as already gone. The config directory stays. */
export async function uninstall(o) {
	if (!deploymentSaved())
		throw new CliError(`nothing is deployed from ${C.CONFIG_DIR}. Another deployment? Set A2A_CONFIG_DIR.`);
	console.error(uninstallPlan());
	if (o["dry-run"]) {
		console.error("Nothing was changed.");
		return;
	}
	await confirmUninstall(Boolean(o.yes));

	const name = C.get("A2A_WORKER_NAME");
	const d1 = C.get("A2A_D1_ID");
	const d1Label = C.get("A2A_D1_NAME") || d1;
	const tunnelish = T.TUNNEL_KEYS.some((k) => C.get(k));
	const removed = [];
	const dir = name || d1 || tunnelish ? T.cfWorkDir(D.workerDir(o)) : "";
	let workerGone = !name;
	let workerError = null;
	if (name) {
		try {
			const r = T.cfCall(dir, ["workers", "delete", name, "--force"], { allowNotFound: true });
			workerGone = true;
			const line = r === null ? `Worker ${name} is already gone` : `Worker ${name}`;
			step(r === null ? line : `removed ${line}`);
			removed.push(line);
		} catch (e) { workerError = e; }
	}
	let tunnelError = null;
	if (tunnelish) {
		try {
			await T.remove(o, { allowMissingProject: true, skipSecrets: workerGone, rerun: `${CLI} uninstall --yes` });
			removed.push("wake tunnel");
		} catch (e) { tunnelError = e; }
	} else step("no tunnel to remove");
	// A 10000 on the Worker delete is an auth failure, not proof the other objects should stay.
	// Remove the tunnel and the D1 database, then report the Worker. Other Worker failures stop first.
	const workerAuth = workerError && /\[10000\]/.test(workerError.message || "") && /cf workers delete/i.test(workerError.message || "");
	if (tunnelError || (workerError && !workerAuth)) {
		const left = [d1 && `D1 ${d1Label} (untouched)`, workerError && name && `Worker ${name}`, tunnelError && "wake tunnel"].filter(Boolean);
		removalError(workerError || tunnelError, { removed, left, workerGone });
	}

	if (d1) {
		try {
			const r = T.cfCall(dir, ["d1", "delete", d1, "--force"], { allowNotFound: true });
			const line = r === null ? `D1 database ${d1} is already gone` : `D1 database ${d1}`;
			step(r === null ? line : `removed ${line}`);
			removed.push(line);
			C.saveConfig({ A2A_D1_ID: null, A2A_D1_NAME: null });
		} catch (e) {
			removalError(e, { removed, left: [`D1 ${C.get("A2A_D1_NAME") || d1} (untouched)`, workerError && name && `Worker ${name}`].filter(Boolean), workerGone });
		}
	} else step("no D1 database id saved");
	if (workerError) removalError(workerError, { removed, left: [name && `Worker ${name}`].filter(Boolean), workerGone });
	C.saveConfig({
		A2A_WORKER_NAME: null, A2A_D1_ID: null, A2A_D1_NAME: null, A2A_BASE_URL: null, A2A_HOSTNAME: null,
		A2A_WORKER_DIR: null, A2A_WORKERS_DEV_SUBDOMAIN: null,
	});
	console.error(kept());
}
