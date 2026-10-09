// Minimal D1 stand-in over node:sqlite (in-memory), with the repo's migrations applied: lets tests drive the real
// Worker fetch handler. Covers what the Worker uses: prepare().bind().first()/all()/run(), RETURNING, and batch().
//
// STORAGE_BACKEND=d1|do runs the same calls against workerd (Miniflare): d1 is a real D1 binding, do is a SQLite
// Durable Object behind src/storage.ts. The Worker code stays in this process; only storage is remote. Calls are
// synchronous via a worker thread and Atomics, so `s.DB.db.prepare(...).get()` keeps working. Unset (the default,
// and what migrations.test.ts's d1On and the CLI tests use) stays on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const BACKEND = process.env.STORAGE_BACKEND || "node";

export function d1(migrationsDir: URL) {
	if (BACKEND !== "node") return remote(migrationsDir);
	const db = new DatabaseSync(":memory:");
	for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort())
		db.exec(fs.readFileSync(new URL(f, migrationsDir), "utf8"));
	return d1On(db);
}

/** The same D1 stand-in over an existing node:sqlite database (e.g. one whose schema a test built step by step). */
export function d1On(db: DatabaseSync) {
	const stmt = (sql: string, args: unknown[] = []): any => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async (col?: string) => {
			const r: any = db.prepare(sql).get(...(args as any[]));
			return r ? (col ? r[col] : { ...r }) : null;
		},
		all: async () => ({ results: db.prepare(sql).all(...(args as any[])).map((r: any) => ({ ...r })), meta: {} }),
		run: async () => {
			const s = db.prepare(sql);
			if (/\breturning\b/i.test(sql)) { const rows = s.all(...(args as any[])); return { results: rows, meta: { changes: rows.length } }; }
			const r = s.run(...(args as any[]));
			return { results: [], meta: { changes: Number(r.changes) } };
		},
	});
	return {
		db,
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: any[]) => {
			db.exec("BEGIN");
			try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
			catch (e) { db.exec("ROLLBACK"); throw e; }
		},
	};
}

const POOL = 8;
let bridge: { port: import("node:worker_threads").MessagePort; flag: Int32Array } | null = null;
let next = 0;
export const remoteStats = { calls: 0, ms: 0 };

async function bundleHarness(): Promise<string> {
	const require = createRequire(new URL("../package.json", import.meta.url));
	const { build } = require("esbuild") as typeof import("esbuild");
	const built = await build({
		entryPoints: [fileURLToPath(new URL("./harness-worker.ts", import.meta.url))],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		external: ["cloudflare:*"],
		target: "es2022",
		logLevel: "silent",
		plugins: [{
			name: "sql-raw",
			setup(b) {
				b.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
					path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
					namespace: "sql-raw",
				}));
				b.onLoad({ filter: /.*/, namespace: "sql-raw" }, (args) => ({
					contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))};`,
					loader: "js",
				}));
			},
		}],
	});
	const file = built.outputFiles?.[0];
	if (!file) throw new Error("storage harness bundle was empty");
	return file.text;
}

let harnessScript: string | null = null;
if (BACKEND !== "node") harnessScript = await bundleHarness();

function bridgeCall(reqPath: string, body: unknown): any {
	if (!bridge) {
		const script = harnessScript;
		if (!script) throw new Error("storage harness was not bundled");
		const { port1, port2 } = new MessageChannel();
		const flag = new Int32Array(new SharedArrayBuffer(4));
		const w = new Worker(new URL("./bridge-thread.mjs", import.meta.url), {
			workerData: { port: port2, flag: flag.buffer, script, pool: POOL },
			transferList: [port2],
		});
		w.on("message", (m) => { if (m?.error) console.error(m.error); });
		bridge = { port: port1, flag };
		if (Atomics.wait(flag, 0, 0, 120_000) === "timed-out") throw new Error("storage bridge did not start");
		const ready = receiveMessageOnPort(port1)?.message;
		if (ready && ready.ready === false) throw new Error(ready.error || "storage bridge did not start");
		// Listening for `message` refs the worker. Drop that ref once Miniflare is up so the test
		// process can exit; workerd stays up for later calls and dies with the process.
		w.unref();
		port1.unref();
	}
	const t0 = performance.now();
	Atomics.store(bridge.flag, 0, 0);
	bridge.port.postMessage({ path: reqPath, body });
	if (Atomics.wait(bridge.flag, 0, 0, 30_000) === "timed-out") throw new Error("storage bridge timeout");
	const m = receiveMessageOnPort(bridge.port)!.message;
	remoteStats.calls++;
	remoteStats.ms += performance.now() - t0;
	if (!m.ok) throw new Error(m.error);
	return m.value;
}

function remote(migrationsDir: URL) {
	let reqPath: string;
	if (BACKEND === "d1") {
		reqPath = `/DB${next++ % POOL}`;
		const files = fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()
			.map((name) => ({ name, sql: fs.readFileSync(new URL(name, migrationsDir), "utf8") }));
		bridgeCall(reqPath, { op: "reset", files });
	} else if (BACKEND === "do") {
		reqPath = `/do/t-${process.pid}-${next++}-${Math.random().toString(36).slice(2)}`;
	} else throw new Error("STORAGE_BACKEND must be node, d1 or do");
	const call = (body: unknown) => bridgeCall(reqPath, body);
	const stmt = (sql: string, args: unknown[] = []): any => ({
		__sql: sql, __args: args,
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async (col?: string) => call({ op: "first", sql, args, col }),
		all: async () => call({ op: "all", sql, args }),
		run: async () => call({ op: "run", sql, args }),
		raw: async () => call({ op: "raw", sql, args }),
	});
	const db = {
		prepare: (sql: string) => ({
			get: (...args: unknown[]) => call({ op: "first", sql, args }) ?? undefined,
			all: (...args: unknown[]) => call({ op: "all", sql, args }).results,
			run: (...args: unknown[]) => { const r = call({ op: "run", sql, args }); return { changes: r.meta.changes }; },
		}),
	};
	return {
		db, path: reqPath,
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: any[]) => call({ op: "batch", stmts: stmts.map((s) => ({ sql: s.__sql, args: s.__args })) }),
	};
}

if (BACKEND !== "node") process.on("exit", () => {
	if (remoteStats.calls) process.stdout.write(`# storage[${BACKEND}] ${remoteStats.calls} ops, avg ${(remoteStats.ms / remoteStats.calls).toFixed(3)} ms/op (incl. thread+HTTP bridge)\n`);
});
