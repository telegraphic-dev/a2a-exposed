// Hosted entrypoint. Used only when the deploy sets TENANCY=host (see cloudflare.config.ts).
// With that set and a TENANT_DO binding, `<name>.<TENANT_DOMAIN>` is looked up in the KV directory and forwarded
// to that tenant's SQLite Durable Object. The object runs the same inbox as self-host (`dispatch` in index.ts)
// against its own database. Anything else — TENANCY unset, or no TENANT_DO binding — calls the self-host fetch
// handler on env.DB.
//
// Tenant config is a versioned row pushed into the object (`pushConfig`). It does not travel on the request.
// An object with no row answers 404 and does not create application tables.
//
// Hosted wake debounce and the cron's housekeeping run from this object's alarm. The Worker minute cron stays a no-op
// while TENANCY=host, so there is no shared database to flush. Self-host still uses its minute cron.
// Not in this change: export, point-in-time restore, R2 backups, and usage push. Approval OIDC, when the
// pushed tenant `approval` object is complete, is enforced by the same pages as self-host.
import { DurableObject } from "cloudflare:workers";
import worker, { cronFlush, dispatch, nextCronAt, onWakeWrite } from "./index.ts";
import { doSqlD1, migrateDo, type SqlStorageLike, type TxRunner } from "./storage.ts";
import { MIGRATIONS } from "./migrations.ts";
import { lookupDirectory, pinDirectoryRegion, tenantNameFromHost, tenantRegion, TENANT_NAME, type DirectoryEntry } from "./directory.ts";
import { hostedTenantContext, namespaceForRegion, parseGates, type WorkerBindings } from "./tenancy.ts";

export { clearDirectoryCache, directoryKey, lookupDirectory, parseDirectoryEntry, pinDirectoryRegion, tenantNameFromHost, tenantRegion, TENANT_NAME } from "./directory.ts";
export type { DirectoryEntry };

const JSON_HDR = { "content-type": "application/json", "cache-control": "no-store" };
const notFound = () => Response.json({ error: "no such agent" }, { status: 404, headers: JSON_HDR });
const unavailable = () => Response.json({ error: "directory unavailable" }, { status: 503, headers: JSON_HDR });
const suspended = () => Response.json({ error: "this agent is suspended" }, { status: 403, headers: JSON_HDR });
const gone = () => Response.json({ error: "this agent is gone" }, { status: 410, headers: JSON_HDR });

const TENANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Versioned config pushed by the control plane. `secretsEnc` is stored and not decrypted here. */
export interface TenantConfigPush {
	version: number;
	tenantId: string;
	name: string;
	status: string;
	config?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	approval?: Record<string, unknown>;
	ownerTokenHash?: string | null;
	secretsEnc?: string | null;
}

interface StoredConfig {
	version: number;
	tenantId: string;
	name: string;
	status: string;
	config: Record<string, string | undefined>;
	limits: Record<string, unknown>;
	approval: Record<string, unknown>;
	ownerTokenHash: string | null;
	secretsEnc: string | null;
}

const CREATE_CONFIG = `CREATE TABLE IF NOT EXISTS tenant_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  approval_json TEXT NOT NULL,
  owner_token_hash TEXT,
  secrets_enc TEXT,
  updated_at TEXT NOT NULL
)`;

function readRow(sql: SqlStorageLike): StoredConfig | null {
	const exists = sql.exec("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'tenant_config'").toArray();
	if (!exists.length) return null;
	const rows = sql.exec("SELECT version, tenant_id, name, status, config_json, limits_json, approval_json, owner_token_hash, secrets_enc FROM tenant_config WHERE id = 1").toArray();
	const r = rows[0];
	if (!r) return null;
	return {
		version: Number(r.version),
		tenantId: String(r.tenant_id),
		name: String(r.name),
		status: String(r.status),
		config: stringRecord(JSON.parse(String(r.config_json || "{}"))),
		limits: objectRecord(JSON.parse(String(r.limits_json || "{}"))),
		approval: objectRecord(JSON.parse(String(r.approval_json || "{}"))),
		ownerTokenHash: r.owner_token_hash == null ? null : String(r.owner_token_hash),
		secretsEnc: r.secrets_enc == null ? null : String(r.secrets_enc),
	};
}

function stringRecord(v: unknown): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	if (!v || typeof v !== "object" || Array.isArray(v)) return out;
	for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
	return out;
}

function objectRecord(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	return v as Record<string, unknown>;
}

function requireObject(v: unknown, what: string): Record<string, unknown> {
	if (v == null) return {};
	if (typeof v !== "object" || Array.isArray(v)) throw new Error(`pushConfig: ${what} must be an object`);
	return v as Record<string, unknown>;
}

function checkPush(body: TenantConfigPush): void {
	if (!body || typeof body !== "object") throw new Error("pushConfig: body is required");
	if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1) throw new Error("pushConfig: version must be an integer >= 1");
	if (typeof body.tenantId !== "string" || !TENANT_ID.test(body.tenantId)) throw new Error("pushConfig: tenantId is invalid");
	if (typeof body.name !== "string" || !TENANT_NAME.test(body.name)) throw new Error("pushConfig: name is invalid");
	if (typeof body.status !== "string" || !/^[a-z]{1,32}$/.test(body.status)) throw new Error("pushConfig: status is invalid");
	if (body.ownerTokenHash != null && body.ownerTokenHash !== "" && !/^[0-9a-fA-F]{64}$/.test(body.ownerTokenHash)) throw new Error("pushConfig: ownerTokenHash must be 64 hex characters");
	if (body.secretsEnc != null && typeof body.secretsEnc !== "string") throw new Error("pushConfig: secretsEnc must be a string");
}

/** Both are required. TENANCY=host alone, or a binding without the flag, stays on env.DB. */
function hostedOn(env: WorkerBindings): env is WorkerBindings & { TENANT_DO: NonNullable<WorkerBindings["TENANT_DO"]> } {
	return env.TENANCY === "host" && !!env.TENANT_DO;
}

function appTables(sql: SqlStorageLike): string[] {
	return sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
		.map((r) => String(r.name))
		.filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_"))
		.sort();
}

export class TenantStore extends DurableObject<WorkerBindings> {
	#sql: SqlStorageLike;
	#tx: TxRunner;
	#db: ReturnType<typeof doSqlD1>;
	#row: StoredConfig | null = null;

	constructor(ctx: DurableObjectState, env: WorkerBindings) {
		super(ctx, env);
		const storage = ctx.storage as unknown as { sql: SqlStorageLike; transactionSync: TxRunner };
		this.#sql = storage.sql;
		// Call through `storage` so `this` stays bound. An extracted method throws Illegal invocation.
		this.#tx = (fn) => storage.transactionSync(fn);
		this.#db = doSqlD1(this.#sql, this.#tx);
		// Read only. Migrations run once a config row exists, so a scan that instantiates an object writes nothing.
		ctx.blockConcurrencyWhile(async () => {
			this.#row = readRow(this.#sql);
			if (this.#row) migrateDo(this.#sql, this.#tx, MIGRATIONS);
			if (this.#row?.status === "active") await this.#enqueueArm(false);
		});
	}

	#tenant(fallbackOrigin = "") {
		const row = this.#row;
		if (!row) return null;
		const domain = parseGates(this.env).gates.tenantDomain;
		const publicUrl = domain ? `https://${row.name}.${domain}` : (fallbackOrigin || this.env.PUBLIC_URL || "");
		return hostedTenantContext(this.env, {
			id: row.tenantId, db: this.#db, publicUrl, ownerTokenHash: row.ownerTokenHash,
			config: row.config, limits: row.limits, approval: row.approval, status: row.status,
		});
	}

	#arming: Promise<void> = Promise.resolve();

	/** Run alarm updates one at a time, so an earlier read cannot setAlarm over a retry row written later. */
	#enqueueArm(afterRun: boolean): Promise<void> {
		const run = this.#arming.then(() => this.#arm(afterRun), () => this.#arm(afterRun));
		this.#arming = run.then(() => undefined, () => undefined);
		return run;
	}

	#ectx(background?: Promise<unknown>[]): ExecutionContext {
		const ectx = {
			waitUntil: (p: Promise<unknown>) => {
				const settled = Promise.resolve(p).then(() => undefined, () => undefined);
				if (background) background.push(settled);
				// Arm when the task finishes, not when it was scheduled. sendWake inserts the retry before it resolves.
				this.ctx.waitUntil(settled.then(() => this.#enqueueArm(false)));
			},
			passThroughOnException() {},
		} as ExecutionContext;
		// requeueWake calls this in the same turn as the insert, including after the inbox response has returned.
		onWakeWrite(ectx, () => this.#enqueueArm(false));
		return ectx;
	}

	/** One alarm per object. `afterRun` waits a second when work is still due, so a full batch cannot spin. */
	async #arm(afterRun: boolean): Promise<void> {
		const storage = this.ctx.storage as unknown as {
			setAlarm(scheduledTime: number): Promise<void>;
			deleteAlarm(): Promise<void>;
		};
		const row = this.#row;
		try {
			if (!row || row.status !== "active") {
				await storage.deleteAlarm();
				return;
			}
			const tenant = this.#tenant();
			if (!tenant) return;
			const at = await nextCronAt(tenant);
			if (at == null || !Number.isFinite(at)) {
				await storage.deleteAlarm();
				return;
			}
			const now = Date.now();
			const when = afterRun && at <= now ? now + 1000 : Math.max(at, now);
			await storage.setAlarm(when);
		} catch (e) {
			console.log(JSON.stringify({ ts: new Date().toISOString(), event: "alarm_arm_failed", error: String(e).slice(0, 200) }));
		}
	}

	/** Same flush and deletes as the self-host minute cron, for this tenant only. */
	async alarm(): Promise<void> {
		const tenant = this.#row?.status === "active" ? this.#tenant() : null;
		if (tenant) {
			try { await cronFlush(tenant, this.#ectx()); }
			catch (e) { console.log(JSON.stringify({ ts: new Date().toISOString(), event: "alarm_failed", error: String(e).slice(0, 200) })); }
		}
		await this.#enqueueArm(true);
	}

	/** When the alarm is set to run, or null. No secrets. */
	async alarmAt(): Promise<number | null> {
		const storage = this.ctx.storage as unknown as { getAlarm(): Promise<number | null> };
		try {
			const at = await storage.getAlarm();
			return typeof at === "number" && Number.isFinite(at) ? at : null;
		} catch {
			return null;
		}
	}

	/**
	 * Control-plane push. A version less than or equal to the stored one is ignored, so a reordered or repeated
	 * push does not roll the row backwards. The first accepted push creates `tenant_config` and then runs migrations.
	 */
	async pushConfig(body: TenantConfigPush): Promise<{ version: number; applied: boolean }> {
		return await this.ctx.blockConcurrencyWhile(async () => {
			checkPush(body);
			const current = this.#row ?? readRow(this.#sql);
			if (current && body.version <= current.version) {
				// A previous push may have stored this version and then failed while migrating. Catch up; don't rewrite the row.
				migrateDo(this.#sql, this.#tx, MIGRATIONS);
				this.#row = current;
				await this.#enqueueArm(false);
				return { version: current.version, applied: false };
			}
			const config = requireObject(body.config, "config");
			const limits = requireObject(body.limits, "limits");
			const approval = requireObject(body.approval, "approval");
			const next: StoredConfig = {
				version: body.version,
				tenantId: body.tenantId,
				name: body.name,
				status: body.status,
				config: stringRecord(config),
				limits,
				approval,
				ownerTokenHash: body.ownerTokenHash ? body.ownerTokenHash.toLowerCase() : null,
				secretsEnc: body.secretsEnc ?? null,
			};
			const now = new Date().toISOString();
			this.#tx(() => {
				this.#sql.exec(CREATE_CONFIG);
				this.#sql.exec(
					`INSERT INTO tenant_config (id, version, tenant_id, name, status, config_json, limits_json, approval_json, owner_token_hash, secrets_enc, updated_at)
					 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   version = excluded.version, tenant_id = excluded.tenant_id, name = excluded.name, status = excluded.status,
					   config_json = excluded.config_json, limits_json = excluded.limits_json, approval_json = excluded.approval_json,
					   owner_token_hash = excluded.owner_token_hash, secrets_enc = excluded.secrets_enc, updated_at = excluded.updated_at`,
					next.version, next.tenantId, next.name, next.status,
					JSON.stringify(config), JSON.stringify(limits), JSON.stringify(approval),
					next.ownerTokenHash, next.secretsEnc, now,
				);
			});
			try {
				migrateDo(this.#sql, this.#tx, MIGRATIONS);
			} finally {
				// Remember the row even if a migration throws, so a later request is not stuck on the empty-object 404.
				this.#row = readRow(this.#sql) ?? next;
			}
			await this.#enqueueArm(false);
			return { version: this.#row.version, applied: true };
		});
	}

	/** No secrets. Tests use this to show a 404 did not create application tables. */
	async storageStatus(): Promise<{ configured: boolean; version: number; tables: string[] }> {
		return { configured: this.#row !== null, version: this.#row?.version ?? 0, tables: appTables(this.#sql) };
	}

	async fetch(req: Request): Promise<Response> {
		const row = this.#row;
		if (!row) return notFound();
		if (row.status !== "active") {
			await this.#enqueueArm(false);
			if (row.status === "suspended") return suspended();
			if (row.status === "deleting") return gone();
			return notFound();
		}
		const tenant = this.#tenant(new URL(req.url).origin);
		if (!tenant) return notFound();
		// Do not arm from the rows visible here. sendWake runs in waitUntil and, on 429/503, inserts the retry
		// after this response returns. requeueWake arms in that insert. Arm again when those tasks finish so a
		// quiet tenant is on Retry-After, not the rate-row timer from an earlier read.
		const background: Promise<unknown>[] = [];
		const res = await dispatch(req, tenant, this.#ectx(background));
		if (background.length) {
			const pending = background.slice();
			this.ctx.waitUntil(Promise.allSettled(pending).then(() => this.#enqueueArm(false)));
		}
		return res;
	}
}

function routeStatus(entry: DirectoryEntry): Response | null {
	if (entry.status === "deleted") return notFound();
	if (entry.status === "suspended") return suspended();
	if (entry.status === "deleting") return gone();
	if (entry.status !== "active") return notFound();
	return null;
}

export default {
	async fetch(req: Request<unknown, IncomingRequestCfProperties>, env: WorkerBindings, ectx: ExecutionContext): Promise<Response> {
		if (!hostedOn(env)) return worker.fetch(req, env, ectx);
		const domain = parseGates(env).gates.tenantDomain;
		const name = tenantNameFromHost(new URL(req.url).hostname, domain);
		if (!name || !env.TENANT_DIRECTORY) return notFound();
		const entry = await lookupDirectory(env.TENANT_DIRECTORY, name);
		if (!entry) return notFound();
		// Pin once, including for a suspended or deleted row, so a later DATA_REGION change cannot move the object.
		const pinned = await pinDirectoryRegion(env.TENANT_DIRECTORY, name, entry, parseGates(env).gates.dataRegion);
		if (!pinned) return unavailable();
		const early = routeStatus(pinned);
		if (early) return early;
		const region = tenantRegion(pinned);
		const ns = namespaceForRegion(env.TENANT_DO, region);
		// The spike carried the tenant row on this header. Drop it so a client cannot supply config.
		const headers = new Headers(req.headers);
		headers.delete("x-a2a-tenant");
		return ns.get(ns.idFromName(entry.id)).fetch(new Request(req, { headers }));
	},
	// Self-host cron flushes env.DB. Hosted has no single database; each tenant's alarm runs that flush.
	async scheduled(controller: ScheduledController, env: WorkerBindings, ectx: ExecutionContext): Promise<void> {
		if (!hostedOn(env)) await worker.scheduled(controller, env, ectx);
	},
};
