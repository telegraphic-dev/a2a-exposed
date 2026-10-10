import worker from "../src/index.ts";
import type { ControlEnv } from "../src/env.ts";

interface Statement {
	bind(...args: unknown[]): Statement;
	first(...args: unknown[]): Promise<unknown>;
	all(...args: unknown[]): Promise<unknown>;
	run(...args: unknown[]): Promise<unknown>;
	raw?(...args: unknown[]): Promise<unknown>;
}

interface Database {
	prepare(sql: string): Statement;
	batch?(statements: Statement[]): Promise<unknown>;
	exec?(sql: string): Promise<unknown>;
}

/**
 * Miniflare's local D1 accepts a binding captured on an earlier request.
 * Production does not: that call waits forever. This wrapper does the same,
 * while the env object stays stable so a cached handler is reused.
 */
let shell: ControlEnv | undefined;
let slot: Database;
let current = 0;
let seq = 0;

function guard(db: Database, id: number): Database {
	const stopped = () => id !== current;
	const block = () => new Promise(() => {});
	const wrap = (stmt: Statement): Statement => ({
		bind: (...args) => wrap(stmt.bind(...args)),
		first: (...args) => stopped() ? block() : stmt.first(...args),
		all: (...args) => stopped() ? block() : stmt.all(...args),
		run: (...args) => stopped() ? block() : stmt.run(...args),
		raw: (...args) => stopped() ? block() : stmt.raw?.(...args),
	});
	return {
		prepare: (sql) => wrap(db.prepare(sql)),
		batch: (statements) => stopped() ? block() : db.batch?.(statements),
		exec: (sql) => stopped() ? block() : db.exec?.(sql),
	};
}

export default {
	fetch(request: Request, env: ControlEnv, ctx: ExecutionContext) {
		const id = ++seq;
		current = id;
		slot = guard(env.DB as Database, id);
		if (!shell) {
			shell = new Proxy(env, {
				get(target, prop, receiver) {
					if (prop === "DB") return slot;
					return Reflect.get(target, prop, receiver);
				},
			}) as ControlEnv;
		}
		return Promise.resolve(worker.fetch(request, shell, ctx)).finally(() => {
			if (current === id) current = 0;
		});
	},
};
