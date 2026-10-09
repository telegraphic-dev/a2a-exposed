// Test harness Worker (workerd under Miniflare). The Node suite sends storage ops here.
// STORAGE_BACKEND=d1 hits a real D1 binding. STORAGE_BACKEND=do hits a SQLite Durable Object through storage.ts.
// This object applies migrations on construct so the existing suite sees a ready inbox. The production TenantStore
// does not: it waits for pushConfig. That path is covered by hosted.test.ts.
import { DurableObject } from "cloudflare:workers";
import { doSqlD1, migrateDo } from "../src/storage.ts";
import { MIGRATIONS } from "../src/migrations.ts";

type Op = {
	op: "first" | "all" | "run" | "raw" | "batch" | "reset" | "migrations";
	sql?: string;
	args?: unknown[];
	col?: string;
	stmts?: { sql: string; args: unknown[] }[];
	files?: { name: string; sql: string }[];
};

async function run(db: ReturnType<typeof doSqlD1> | D1Database, o: Op) {
	const s = (sql: string, args: unknown[] = []) => db.prepare(sql).bind(...args);
	switch (o.op) {
		case "first": return o.col ? s(o.sql!, o.args).first(o.col) : s(o.sql!, o.args).first();
		case "all": return s(o.sql!, o.args).all();
		case "run": return s(o.sql!, o.args).run();
		case "raw": return s(o.sql!, o.args).raw();
		case "batch": return db.batch(o.stmts!.map((x) => s(x.sql, x.args)));
		default: throw new Error("bad op " + o.op);
	}
}

/** Split a migration file into statements. This repo's migrations have no triggers and no BEGIN/END blocks. */
function split(sql: string): string[] {
	return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
}

export class Store extends DurableObject {
	db: ReturnType<typeof doSqlD1>;
	applied: string[] = [];
	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		const storage = ctx.storage as unknown as { sql: Parameters<typeof doSqlD1>[0]; transactionSync: Parameters<typeof doSqlD1>[1] };
		const tx: Parameters<typeof doSqlD1>[1] = (fn) => storage.transactionSync(fn);
		this.db = doSqlD1(storage.sql, tx);
		ctx.blockConcurrencyWhile(async () => { this.applied = migrateDo(storage.sql, tx, MIGRATIONS); });
	}
	async fetch(req: Request) {
		const o = await req.json() as Op;
		try {
			if (o.op === "migrations") {
				const recorded = this.ctx.storage.sql.exec("SELECT name FROM d1_migrations ORDER BY id").toArray().map((r) => String(r.name));
				return Response.json({ ok: true, value: { applied: this.applied, recorded } });
			}
			return Response.json({ ok: true, value: await run(this.db, o) ?? null });
		} catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
	}
}

export default {
	async fetch(req: Request, env: Record<string, D1Database | DurableObjectNamespace>) {
		const url = new URL(req.url);
		const o = await req.json() as Op;
		if (url.pathname.startsWith("/do/")) {
			const ns = env.STORE as DurableObjectNamespace;
			const id = ns.idFromName(url.pathname.slice(4));
			return ns.get(id).fetch("https://do/", { method: "POST", body: JSON.stringify(o) });
		}
		const db = env[url.pathname.slice(1)] as D1Database;
		try {
			if (o.op === "reset") {
				const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results?.map((r) => String((r as { name: string }).name)) ?? [];
				if (tables.length) await db.batch(["PRAGMA foreign_keys=OFF", ...tables.map((t) => `DROP TABLE IF EXISTS "${t}"`)].map((q) => db.prepare(q)));
				for (const f of o.files ?? []) {
					const st = split(f.sql);
					if (st.length) await db.batch(st.map((q) => db.prepare(q)));
				}
				return Response.json({ ok: true, value: null });
			}
			return Response.json({ ok: true, value: await run(db, o) ?? null });
		} catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
	},
};
