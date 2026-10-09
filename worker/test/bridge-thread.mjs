// Worker thread that owns one Miniflare and answers storage ops for the synchronous test shim in d1.ts.
import { workerData, parentPort } from "node:worker_threads";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const { port, flag, script, pool } = workerData;
const d1Databases = Object.fromEntries(Array.from({ length: pool }, (_, i) => [`DB${i}`, `db-${i}-${process.pid}`]));
const i32 = new Int32Array(flag);

try {
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a-storage",
		modules: true,
		script,
		compatibilityDate: "2026-10-06",
		d1Databases,
		durableObjects: { STORE: { className: "Store", useSQLite: true } },
	}));
	await mf.ready;
	port.on("message", async ({ path, body }) => {
		let msg;
		try {
			const r = await mf.dispatchFetch("http://h" + path, { method: "POST", body: JSON.stringify(body) });
			msg = await r.json();
		} catch (e) {
			msg = { ok: false, error: "bridge: " + (e instanceof Error ? e.message : String(e)) };
		}
		port.postMessage(msg);
		Atomics.store(i32, 0, 1);
		Atomics.notify(i32, 0);
	});
	port.postMessage({ ready: true });
	Atomics.store(i32, 0, 1);
	Atomics.notify(i32, 0);
} catch (e) {
	const error = "bridge start: " + (e instanceof Error ? e.stack || e.message : String(e));
	parentPort?.postMessage({ error });
	port.postMessage({ ready: false, error });
	Atomics.store(i32, 0, 1);
	Atomics.notify(i32, 0);
}
