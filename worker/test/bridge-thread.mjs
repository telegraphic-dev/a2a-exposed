// This isolated thread owns every child it spawns. Retain handles (not PID/path
// searches) so even a rejected or stalled Miniflare.dispose has a bounded fallback.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { workerData, parentPort } from "node:worker_threads";
const children = new Set();
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
	const child = spawn.apply(this, args);
	children.add(child);
	child.once("exit", () => children.delete(child));
	child.once("error", () => children.delete(child));
	return child;
};
syncBuiltinESMExports();
const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
const { port, flag, script, pool } = workerData;
const i32 = new Int32Array(flag);
const reply = msg => {
	port.postMessage(msg);
	Atomics.store(i32, 0, 1);
	Atomics.notify(i32, 0);
};
let mf;
let closing;
for (const event of ["uncaughtException", "unhandledRejection"]) process.once(event, error => {
	console.error(error);
	process.exitCode = 1;
	reply({ ok: false, fatal: true, error: "storage bridge thread failed" });
	void dispose();
});
function dispose() {
	if (closing) return closing;
	closing = (async () => {
		let timer;
		try {
			await Promise.race([Promise.resolve().then(() => mf?.dispose()), new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("storage runtime disposal timed out")), 5000);
			})]);
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
		} finally {
			clearTimeout(timer);
			// Usually empty: Miniflare.dispose already kills and awaits workerd.
			await Promise.all([...children].map(child => new Promise(resolve => {
				child.once("exit", resolve);
				child.kill("SIGKILL");
			})));
			parentPort?.postMessage({ disposed: true, failed: process.exitCode === 1 });
			port.close(); parentPort?.close();
		}
	})();
	return closing;
}
// Install before startup so a startup timeout can still request teardown.
port.on("message", async message => {
	if (message.dispose) { await dispose(); return; }
	if (closing) return;
	let msg;
	try {
		await ready;
		const r = await mf.dispatchFetch("http://h" + message.path, { method: "POST", body: JSON.stringify(message.body) });
		msg = await r.json();
	} catch (error) {
		// Infrastructure/RPC failure is terminal; ordinary SQL errors are JSON replies.
		msg = { ok: false, fatal: true, error: "storage bridge RPC failed" };
		reply(msg);
		await dispose();
		return;
	}
	reply(msg);
});
const ready = (async () => {
	try {
		const d1Databases = Object.fromEntries(Array.from({ length: pool }, (_, i) => [`DB${i}`, `db-${i}-${process.pid}`]));
		mf = new Miniflare(convertV4MiniflareOptions({
			name: "a2a-storage", modules: true, script,
			compatibilityDate: "2026-10-06", d1Databases,
			durableObjects: { STORE: { className: "Store", useSQLite: true } },
		}));
		await mf.ready;
		if (!closing) reply({ ready: true });
	} catch (error) {
		// Dispose partial startup before notifying the synchronous caller.
		await dispose();
		// The port is closed now; publish the failure first through the shared flag.
		Atomics.store(i32, 0, 1); Atomics.notify(i32, 0);
	}
})();
