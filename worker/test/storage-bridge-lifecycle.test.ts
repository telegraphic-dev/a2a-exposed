import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Discover descendants while the fixture is alive, then retain their exact PIDs.
// Never search by command path or signal another test's runtime.
function processes() {
	return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,comm="], { encoding: "utf8" }).trim().split("\n").map(line => {
		const [pid, ppid, stat, ...command] = line.trim().split(/\s+/);
		return { pid: Number(pid), ppid: Number(ppid), stat, command: command.join(" ") };
	});
}
function alive(pid: number) { return processes().some(p => p.pid === pid && !p.stat.startsWith("Z")); }
async function until(check: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await delay(50);
	assert.ok(check(), "lifecycle condition did not settle before deadline");
}

for (const backend of ["d1", "do"]) for (const mode of ["normal", "SIGINT", "SIGTERM", "sql-error", "startup-failure", "rpc-failure", "rpc-timeout", "dispose-timeout"]) {
	test(`native storage bridge reaps workerd: ${backend} ${mode}`, { skip: process.platform === "win32", timeout: 65_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "storage-lifecycle-"));
		const readyFile = join(dir, "ready"); const finishFile = join(dir, "finish");
		const source = `
			import test from 'node:test';
			import assert from 'node:assert/strict';
			import { writeFileSync, existsSync } from 'node:fs';
			import { setTimeout as delay } from 'node:timers/promises';
			import { d1 } from ${JSON.stringify(new URL('./d1.ts', import.meta.url).href)};
			let retained;
			test('storage fixture', async () => {
				let db;
				try { db = d1(new URL(${JSON.stringify(new URL('../migrations/', import.meta.url).href)}));
				await db.prepare('SELECT 0 AS n').all();
				} catch (error) { if (${JSON.stringify(mode)} === 'startup-failure') return; throw error; }
				assert.notEqual(${JSON.stringify(mode)}, 'startup-failure', 'startup fault must be exercised');
				retained = db;
				await db.prepare('SELECT 1 AS n').all();
				writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
				while (!existsSync(${JSON.stringify(finishFile)})) await delay(50);
				if (['rpc-failure', 'rpc-timeout'].includes(${JSON.stringify(mode)})) {
					assert.throws(() => db.db.prepare('SELECT 99 AS n').get(), /storage bridge/);
				}
				if (${JSON.stringify(mode)} === 'sql-error') {
					// SQL errors must not dispose the shared runtime prematurely.
					try { await db.prepare('SELECT * FROM missing_table').all(); } catch {}
					await db.prepare('SELECT 2 AS n').all();
				}
			});
			test('shared storage remains available to later tests', async () => {
				if (['normal', 'sql-error'].includes(${JSON.stringify(mode)})) await retained.prepare('SELECT 3 AS n').all();
			});`;
		const env = { ...process.env, STORAGE_BACKEND: backend };
		delete env.NODE_TEST_CONTEXT;
		const fixture = join(dir, "fixture.mjs"); writeFileSync(fixture, source);
		// Fault injection wraps the actual Miniflare, never a fake native runtime.
		const wrapper = join(dir, "miniflare.mjs"); const hook = join(dir, "inject.mjs");
		writeFileSync(wrapper, `
			import { Miniflare as Real, convertV4MiniflareOptions } from ${JSON.stringify(new URL('../node_modules/miniflare/dist/src/index.js', import.meta.url).href)};
			import { writeFileSync, existsSync } from 'node:fs';
			import { setTimeout as delay } from 'node:timers/promises';
			export { convertV4MiniflareOptions };
			export class Miniflare {
				constructor(options) { this.real = new Real(options); }
				get ready() { return this.real.ready.then(async value => {
					if (${JSON.stringify(mode)} === 'startup-failure') {
						writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
						while (!existsSync(${JSON.stringify(finishFile)})) await delay(20);
						throw new Error('injected startup failure after native ready');
					}
					return value;
				}); }
				dispatchFetch(url, options) {
					if (options.body.includes('SELECT 99')) {
						if (${JSON.stringify(mode)} === 'rpc-failure') throw new Error('injected RPC failure');
						if (${JSON.stringify(mode)} === 'rpc-timeout') return new Promise(() => {});
					}
					return this.real.dispatchFetch(url, options);
				}
				dispose() { return ${JSON.stringify(mode)} === 'dispose-timeout' ? new Promise(() => {}) : this.real.dispose(); }
			}`);
		writeFileSync(hook, `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) { return specifier === 'miniflare' ? { url: ${JSON.stringify(new URL('file://' + wrapper).href)}, shortCircuit: true } : next(specifier, context); } });`);
		const child = spawn(process.execPath, ["--import", "./test/register-hooks.mjs", "--import", hook, "--test", fixture], {
			cwd: new URL("../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
		const exited = once(child, "exit");
		const owned = new Set<number>();
		try {
			await until(() => {
				if (child.exitCode !== null) throw new Error(output);
				return existsSync(readyFile);
			}, 25_000);
			const rows = processes(); const descendants = new Set([child.pid!]);
			for (let i = 0; i < rows.length; i++) for (const p of rows) if (descendants.has(p.ppid)) descendants.add(p.pid);
			for (const p of rows) if (descendants.has(p.pid) && /workerd/.test(p.command)) owned.add(p.pid);
			assert.ok(owned.size > 0, "fixture must launch real native workerd");
			if (mode.startsWith("SIG")) process.kill(Number(readFileSync(readyFile, "utf8")), mode as NodeJS.Signals);
			else writeFileSync(finishFile, "finish");
			await until(() => child.exitCode !== null || child.signalCode !== null, 45_000);
			await until(() => [...owned].every(pid => !alive(pid)), 3000);
			if (!["SIGINT", "SIGTERM", "dispose-timeout"].includes(mode)) assert.equal(child.exitCode, 0, output);
			if (mode === "dispose-timeout") assert.notEqual(child.exitCode, 0, "disposal failure must fail the suite");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
			await exited;
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
