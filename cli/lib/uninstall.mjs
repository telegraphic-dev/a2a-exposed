// `uninstall`: remove the wake tunnel (when one is saved), the Worker, and the D1 database for this config.
import readline from "node:readline/promises";
import { CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as D from "./deploy.mjs";
import * as T from "./tunnel.mjs";

const step = (s) => console.error(`==> ${s}`);

/** Ask before deleting. On a terminal, wait for y or yes unless `yes` is set. Off a terminal, `--yes` is required. */
export async function confirmUninstall(yes, input = process.stdin, output = process.stderr) {
	if (yes) return;
	if (!input.isTTY) throw new CliError("uninstall removes the Worker, the D1 database, and the wake tunnel. Pass --yes.");
	const rl = readline.createInterface({ input, output });
	try {
		const answer = (await rl.question("Remove the Worker, the D1 database, and the wake tunnel? [y/N] ")).trim().toLowerCase();
		if (answer !== "y" && answer !== "yes") throw new CliError("uninstall cancelled");
	} finally {
		rl.close();
	}
}

const kept = () => `config directory kept at ${C.CONFIG_DIR} (owner token and peer tokens). Remove that directory to delete them.`;

/** One line per removal. A 404 counts as already gone. The config directory stays. */
export async function uninstall(o) {
	await confirmUninstall(Boolean(o.yes));
	const tunnelish = T.TUNNEL_KEYS.some((k) => C.get(k));
	if (tunnelish) await T.remove(o, { allowMissingProject: true });
	else step("no tunnel to remove");

	const name = C.get("A2A_WORKER_NAME");
	const d1 = C.get("A2A_D1_ID");
	const dir = name || d1 ? T.cfWorkDir(D.workerDir(o)) : "";
	if (name) {
		const r = T.cfCall(dir, ["workers", "delete", name, "--force"], { allowNotFound: true });
		step(r === null ? `Worker ${name} is already gone` : `removed Worker ${name}`);
	} else step("no Worker name saved");
	if (d1) {
		const r = T.cfCall(dir, ["d1", "delete", d1, "--force"], { allowNotFound: true });
		step(r === null ? `D1 database ${d1} is already gone` : `removed D1 database ${d1}`);
	} else step("no D1 database id saved");
	C.saveConfig({
		A2A_WORKER_NAME: null, A2A_D1_ID: null, A2A_D1_NAME: null, A2A_BASE_URL: null, A2A_HOSTNAME: null,
		A2A_WORKER_DIR: null, A2A_WORKERS_DEV_SUBDOMAIN: null,
	});
	console.error(kept());
}
