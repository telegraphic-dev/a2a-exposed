// Tenant context for the data-plane Worker.
//
// Self-host (TENANCY unset, the default): one implicit tenant, config and OWNER_TOKEN taken from the Worker env.
// Handlers receive this object instead of reading env.* themselves. With every gate unset, owner checks and the
// outbound peer-token key are the same operations as before (existing ciphertext still decrypts).
//
// Hosted (a TenantContext built with a pushed tenant overlay): owner auth is a constant-time compare against
// owner_token_hash, and the peer-token key is derived from TENANT_SECRETS_KEY and the tenant id. The Worker
// fetch path does not build that overlay; the hosted router does, and only when TENANCY=host and TENANT_DO are
// both set. Settings below are parsed either way. Nothing here turns on quotas, metering, wake policy, branding
// those stay reserved until a later change reads ctx.gates. Approval OIDC is enforced by the approval pages when
// the issuer, client id, client secret and an allowlist are all set (approval-oidc.ts).

import * as A from "./a2a.ts";

/** Subset of D1 used by the handlers. A Durable Object adapter satisfies the same shape. */
export interface SqlDb {
	prepare(query: string): SqlStmt;
	batch(statements: SqlStmt[]): Promise<{ results?: unknown[]; meta: { changes?: number; last_row_id?: number } }[]>;
	exec?(query: string): Promise<{ count: number; duration: number }>;
}

export interface SqlStmt {
	bind(...values: unknown[]): SqlStmt;
	first<T = unknown>(colName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<{ results?: T[] }>;
	run(): Promise<{ results?: unknown[]; meta: { changes?: number; last_row_id?: number } }>;
	raw?<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]>;
}

/** Plain config copied onto the context. Secrets are not in this list. */
export const CONFIG_KEYS = [
	"RETIRED_HOSTNAMES",
	"AGENT_NAME", "AGENT_DESCRIPTION", "AGENT_VERSION", "AGENT_SKILLS",
	"PROVIDER_ORGANIZATION", "PROVIDER_URL", "DOCUMENTATION_URL",
	"WAKE_WEBHOOK_URL", "WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET", "WAKE_ACCESS_CLIENT_ID", "WAKE_ACCESS_CLIENT_SECRET",
	"WAKE_PRESET", "WAKE_AGENT_ID", "WAKE_KEY_HEADER", "WAKE_KEY_PREFIX", "WAKE_BODY_TEMPLATE", "WAKE_CLI_COMMAND",
	"WAKE_DEBOUNCE_SECONDS", "WAKE_MAX_PER_HOUR",
	"MAX_BODY", "RATE_PER_MIN",
	"PAIRING_APPROVAL", "PBKDF2_ITERATIONS",
	"UPSTREAM_URL", "UPSTREAM_CARD_URL", "UPSTREAM_TOKEN", "UPSTREAM_ACCESS_CLIENT_ID", "UPSTREAM_ACCESS_CLIENT_SECRET",
	"MCP",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigFields = { [K in ConfigKey]?: string };

/**
 * Non-secret platform defaults a hosted tenant inherits when its pushed config omits them.
 * Wake secrets, upstream secrets and OWNER_TOKEN are never inherited: in hosted mode they come only from the
 * tenant overlay (or not at all). Decrypting `secrets_enc` into wake credentials is a follow-up.
 */
const HOSTED_PLATFORM_DEFAULTS: readonly ConfigKey[] = ["MAX_BODY", "RATE_PER_MIN", "PBKDF2_ITERATIONS", "MCP", "PAIRING_APPROVAL"];

/** Bindings the Worker entry sees. Gate bindings are optional and empty by default. */
export interface WorkerBindings extends ConfigFields {
	DB: SqlDb;
	PUBLIC_URL?: string;
	OWNER_TOKEN?: string;
	// --- gates (spec §6 / plan §4.3). Unset = today's behaviour. Reserved ones are parsed onto ctx.gates only. ---
	TENANCY?: string;
	TENANT_SECRETS_KEY?: string;
	TENANT_DOMAIN?: string;
	/** KV name directory: tenant name → {id,status,region,version}. Read by the hosted router. */
	TENANT_DIRECTORY?: KvNamespace;
	/**
	 * Daily SQL snapshots. Present only when the deploy sets A2A_BACKUP_BUCKET=1.
	 * Unset: no backup cron and no bucket.
	 */
	BACKUP_BUCKET?: {
		put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
		list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
			objects?: { key: string }[];
			truncated?: boolean;
			cursor?: string;
		}>;
		delete(keys: string[]): Promise<void>;
	};
	/** SQLite Durable Object namespace, one object per tenant. Storage stays env.DB until this is bound. */
	TENANT_DO?: DoNamespace;
	/** unset | eu | fedramp. Applied as a DO jurisdiction when the hosted router addresses a tenant. */
	DATA_REGION?: string;
	/** "on" reserves quota enforcement (not applied yet). */
	QUOTAS?: string;
	/** "d1" reserves usage metering (not applied yet). */
	USAGE_SINK?: string;
	/** "public-https" refuses non-https, private, and metadata wake targets. Anything else is unset. */
	WAKE_TARGET_POLICY?: string;
	/** https URL shown later on the landing page and over-quota errors. Parsed, not rendered yet. */
	SIGNUP_URL?: string;
	/** "hosted" reserves footer / plan badge. Parsed, not rendered yet. */
	BRANDING?: string;
	APPROVAL_OIDC_ISSUER?: string;
	APPROVAL_OIDC_CLIENT_ID?: string;
	APPROVAL_OIDC_CLIENT_SECRET?: string;
	/** Comma-separated `sub` or `email` values allowed to approve. Email matches only when `email_verified` is true. */
	APPROVAL_OIDC_ALLOWED_SUBJECTS?: string;
	/** Comma-separated: password, oidc. Unset keeps the password and also offers OIDC once it is fully configured. */
	APPROVAL_METHODS?: string;
}

export interface KvNamespace {
	get(key: string, type: "json"): Promise<unknown>;
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	/** Present on Cloudflare KV. Optional so test doubles that only get and put still typecheck. */
	list?(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}>;
}

/** Enough of a Durable Object namespace to address a tenant. `jurisdiction` is optional on older typings. */
export interface DoNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(req: Request): Promise<Response> };
	jurisdiction?(loc: string): DoNamespace;
}

export type TenancyMode = "single" | "host";
export type DataRegion = "" | "eu" | "fedramp";

export interface ApprovalOidcGate {
	/** Issuer URL, or "" when unset / not https. */
	issuer: string;
	clientId: string;
	/** True when a client secret is present. The secret itself stays off the gate. */
	hasClientSecret: boolean;
	allowedSubjects: string[];
	/** Unset → ["password"]. See `methodsSpecified` for whether that default was explicit. */
	methods: string[];
	/** True only when the setting listed at least one of password or oidc. Unset is false. */
	methodsSpecified: boolean;
	/** Short button label from hosted approval config, or "". */
	label: string;
}

export interface FeatureGates {
	tenancy: TenancyMode;
	/**
	 * True only when TENANCY is exactly "host" and TENANT_DO is bound. That is the switch for per-tenant storage.
	 * Any other combination, including TENANCY=host alone, keeps the self-host path on env.DB.
	 */
	hostedStorage: boolean;
	quotas: boolean;
	usageSink: "" | "d1";
	wakeTargetPolicy: "" | "public-https";
	signupUrl: string;
	branding: "" | "hosted";
	dataRegion: DataRegion;
	tenantDomain: string;
	approvalOidc: ApprovalOidcGate;
}

/** Pushed tenant row (control plane → DO). PR1 tests build a context from this; the DO stores it in PR2. */
export interface HostedOverlay {
	id: string;
	db: SqlDb;
	publicUrl: string;
	ownerTokenHash?: string | null;
	/** Non-secret and, when the control plane includes them, secret config fields. Never OWNER_TOKEN. */
	config?: Record<string, string | undefined>;
	limits?: Record<string, unknown>;
	approval?: Record<string, unknown>;
	status?: string;
}

export interface ParsedGates {
	gates: FeatureGates;
	secretsKey?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** HKDF info for outbound peer tokens. Self-host uses the bare label so existing ciphertext decrypts. */
export const PEER_KEY_INFO = "outbound-peer-token v1";
const PEER_KEY_SALT = "a2a-exposed";

/** Hosted info binds the key to one tenant. The NUL keeps a tenant id from colliding with the version label. */
export function peerKeyInfoForTenant(tenantId: string): string {
	return `${PEER_KEY_INFO}\0${tenantId}`;
}

/** AES-GCM key for outbound peer tokens. `info` defaults to the self-host label. */
export async function derivePeerKey(ikm: string, info = PEER_KEY_INFO): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(ikm), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(PEER_KEY_SALT), info: new TextEncoder().encode(info) },
		base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
	);
}

function csv(v: string | undefined): string[] {
	return (v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** https URL with no userinfo, or "" when the value is missing or not https. The string is kept as configured. */
function httpsUrl(v: string | undefined): string {
	const s = (v || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s);
		if (u.protocol !== "https:" || u.username || u.password) return "";
		return s;
	} catch { return ""; }
}

const LABEL_MAX = 40;

function recognizedMethods(raw: string[]): { methods: string[]; specified: boolean } {
	const methods = raw.map((s) => s.trim().toLowerCase()).filter((s) => s === "password" || s === "oidc");
	return { methods: methods.length ? methods : ["password"], specified: methods.length > 0 };
}

function shortLabel(v: unknown): string {
	if (typeof v !== "string") return "";
	const s = v.trim();
	if (!s || s.length > LABEL_MAX || /[\u0000-\u001f<>]/.test(s)) return "";
	return s;
}

function subjectsOf(v: unknown): string[] {
	const list = Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : typeof v === "string" ? csv(v) : [];
	return list.map((s) => s.trim()).filter(Boolean).slice(0, 100);
}

/** Approval gate from a hosted tenant's pushed `approval` object (camelCase). The client secret is returned beside the gate. */
export function approvalFromRecord(raw: Record<string, unknown> | undefined): { gate: ApprovalOidcGate; clientSecret: string; publicRecord: Record<string, unknown> } {
	const { methods, specified } = recognizedMethods(Array.isArray(raw?.methods) ? raw!.methods.map((s) => String(s)) : typeof raw?.methods === "string" ? csv(raw.methods) : []);
	const clientSecret = typeof raw?.clientSecret === "string" ? raw.clientSecret.trim() : "";
	const publicRecord: Record<string, unknown> = raw ? { ...raw } : {};
	delete publicRecord.clientSecret;
	delete publicRecord.client_secret;
	return {
		clientSecret,
		publicRecord,
		gate: {
			issuer: httpsUrl(typeof raw?.issuer === "string" ? raw.issuer : ""),
			clientId: typeof raw?.clientId === "string" ? raw.clientId.trim() : "",
			hasClientSecret: !!clientSecret,
			allowedSubjects: subjectsOf(raw?.allowedSubjects),
			methods, methodsSpecified: specified, label: shortLabel(raw?.label),
		},
	};
}

/** Exact tokens only. Anything else is the unset behaviour, so a typo cannot turn a gate on. */
export function parseGates(env: WorkerBindings): ParsedGates {
	const tenancy: TenancyMode = env.TENANCY === "host" ? "host" : "single";
	const regionRaw = (env.DATA_REGION || "").trim().toLowerCase();
	const dataRegion: DataRegion = regionRaw === "eu" || regionRaw === "fedramp" ? regionRaw : "";
	const parsedMethods = recognizedMethods(csv(env.APPROVAL_METHODS));
	return {
		secretsKey: (env.TENANT_SECRETS_KEY || "").trim() || undefined,
		gates: {
			tenancy,
			hostedStorage: tenancy === "host" && !!env.TENANT_DO,
			quotas: env.QUOTAS === "on",
			usageSink: env.USAGE_SINK === "d1" ? "d1" : "",
			wakeTargetPolicy: env.WAKE_TARGET_POLICY === "public-https" ? "public-https" : "",
			signupUrl: httpsUrl(env.SIGNUP_URL),
			branding: env.BRANDING === "hosted" ? "hosted" : "",
			dataRegion,
			tenantDomain: (env.TENANT_DOMAIN || "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""),
			approvalOidc: {
				issuer: httpsUrl(env.APPROVAL_OIDC_ISSUER),
				clientId: (env.APPROVAL_OIDC_CLIENT_ID || "").trim(),
				hasClientSecret: !!(env.APPROVAL_OIDC_CLIENT_SECRET || "").trim(),
				allowedSubjects: csv(env.APPROVAL_OIDC_ALLOWED_SUBJECTS),
				methods: parsedMethods.methods,
				methodsSpecified: parsedMethods.specified,
				label: "",
			},
		},
	};
}

/**
 * DO namespace for a tenant. `eu` and `fedramp` select that jurisdiction; anything else uses the namespace's
 * default placement. The same name in another jurisdiction is a different object. Callers pass the region stored
 * on the directory entry (`pinDirectoryRegion` writes it once).
 */
export function namespaceForRegion<T extends { jurisdiction?(loc: string): T }>(ns: T, region: string): T {
	if ((region === "eu" || region === "fedramp") && typeof ns.jurisdiction === "function") return ns.jurisdiction(region);
	return ns;
}

function pickConfig(src: ConfigFields | Record<string, string | undefined> | undefined, keys: readonly ConfigKey[]): ConfigFields {
	const out: ConfigFields = {};
	if (!src) return out;
	for (const k of keys) {
		const v = src[k];
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/**
 * One tenant's view of config, storage and auth. Handlers take this and do not read Worker bindings themselves.
 * `mode: "single"` is every self-host deploy and any process that has not been handed a hosted overlay.
 */
export class TenantContext implements ConfigFields {
	readonly id: string;
	readonly mode: TenancyMode;
	readonly status: string;
	readonly DB: SqlDb;
	readonly PUBLIC_URL: string;
	readonly gates: FeatureGates;
	readonly limits: Record<string, unknown>;
	readonly approval: Record<string, unknown>;
	readonly RETIRED_HOSTNAMES?: string;
	readonly AGENT_NAME?: string;
	readonly AGENT_DESCRIPTION?: string;
	readonly AGENT_VERSION?: string;
	readonly AGENT_SKILLS?: string;
	readonly PROVIDER_ORGANIZATION?: string;
	readonly PROVIDER_URL?: string;
	readonly DOCUMENTATION_URL?: string;
	readonly WAKE_WEBHOOK_URL?: string;
	readonly WAKE_WEBHOOK_KEY?: string;
	readonly WAKE_HMAC_SECRET?: string;
	readonly WAKE_ACCESS_CLIENT_ID?: string;
	readonly WAKE_ACCESS_CLIENT_SECRET?: string;
	readonly WAKE_PRESET?: string;
	readonly WAKE_AGENT_ID?: string;
	readonly WAKE_KEY_HEADER?: string;
	readonly WAKE_KEY_PREFIX?: string;
	readonly WAKE_BODY_TEMPLATE?: string;
	readonly WAKE_CLI_COMMAND?: string;
	readonly WAKE_DEBOUNCE_SECONDS?: string;
	readonly WAKE_MAX_PER_HOUR?: string;
	readonly MAX_BODY?: string;
	readonly RATE_PER_MIN?: string;
	readonly PAIRING_APPROVAL?: string;
	readonly PBKDF2_ITERATIONS?: string;
	readonly UPSTREAM_URL?: string;
	readonly UPSTREAM_CARD_URL?: string;
	readonly UPSTREAM_TOKEN?: string;
	readonly UPSTREAM_ACCESS_CLIENT_ID?: string;
	readonly UPSTREAM_ACCESS_CLIENT_SECRET?: string;
	readonly MCP?: string;

	/** Self-host only. Never set on a hosted context, so a platform OWNER_TOKEN cannot unlock a tenant. */
	readonly #ownerToken?: string;
	/** Hosted only: lowercase hex SHA-256 of the owner token (the same hash peer tokens use, not PBKDF2). */
	readonly #ownerTokenHash?: string;
	readonly #secretsKey?: string;
	/** OpenID Connect client secret. Never logged and never copied onto `gates`. */
	readonly #approvalClientSecret?: string;
	#peerKey: Promise<CryptoKey | null> | null = null;

	constructor(init: {
		id: string; mode: TenancyMode; status: string; db: SqlDb; publicUrl: string;
		gates: FeatureGates; limits: Record<string, unknown>; approval: Record<string, unknown>;
		config: ConfigFields; ownerToken?: string; ownerTokenHash?: string; secretsKey?: string;
		approvalClientSecret?: string;
	}) {
		this.id = init.id;
		this.mode = init.mode;
		this.status = init.status;
		this.DB = init.db;
		this.PUBLIC_URL = init.publicUrl;
		this.gates = init.gates;
		this.limits = init.limits;
		this.approval = init.approval;
		this.#ownerToken = init.ownerToken;
		this.#ownerTokenHash = init.ownerTokenHash;
		this.#secretsKey = init.secretsKey;
		this.#approvalClientSecret = init.approvalClientSecret;
		Object.assign(this, init.config);
	}

	/** OpenID Connect client secret, or "" when unset. Callers must not log the return value. */
	approvalClientSecret(): string {
		return this.#approvalClientSecret || "";
	}

	/**
	 * Owner bearer check.
	 * Self-host: hash both the presented token and OWNER_TOKEN, then compare (unchanged).
	 * Hosted: hash the presented token once and compare to the stored owner_token_hash. No plaintext owner token.
	 * Both compares are constant-time on the 64-char digests. A missing credential returns before hashing, as today
	 * for an unset OWNER_TOKEN.
	 */
	async isOwner(header: string | null): Promise<boolean> {
		if (!header || !/^bearer /i.test(header)) return false;
		const presented = header.slice(7).trim();
		if (this.mode === "single") {
			if (!this.#ownerToken) return false;
			return A.timingSafeEqualStr(await A.sha256(presented), await A.sha256(this.#ownerToken));
		}
		if (!this.#ownerTokenHash || !HEX64.test(this.#ownerTokenHash)) return false;
		const got = await A.sha256(presented);
		// Digest length is fixed, so the length check inside timingSafeEqualStr does not leak the secret.
		return A.timingSafeEqualStr(got, this.#ownerTokenHash);
	}

	/**
	 * Key that seals `outbound_peers.token_enc`.
	 * Self-host: HKDF(OWNER_TOKEN) with the historical salt and info (byte-identical to the previous helper).
	 * Hosted: HKDF(TENANT_SECRETS_KEY) with info bound to the tenant id. Null when the material is missing.
	 */
	peerKey(): Promise<CryptoKey | null> {
		if (!this.#peerKey) this.#peerKey = this.#derivePeerKey();
		return this.#peerKey;
	}

	async #derivePeerKey(): Promise<CryptoKey | null> {
		if (this.mode === "single") return this.#ownerToken ? derivePeerKey(this.#ownerToken) : null;
		if (!this.#secretsKey || !this.id) return null;
		return derivePeerKey(this.#secretsKey, peerKeyInfoForTenant(this.id));
	}
}

/** Self-host context from Worker bindings. `req` rewrites PUBLIC_URL the way the fetch handler always has. */
export function resolveTenant(env: WorkerBindings, req?: Request): TenantContext {
	const { gates } = parseGates(env);
	const publicUrl = req ? A.publicOrigin(env.PUBLIC_URL, req.url) : (env.PUBLIC_URL || "");
	return new TenantContext({
		id: "", mode: "single", status: "active", db: env.DB, publicUrl, gates,
		limits: {}, approval: {}, config: pickConfig(env, CONFIG_KEYS),
		ownerToken: env.OWNER_TOKEN, secretsKey: undefined,
		approvalClientSecret: (env.APPROVAL_OIDC_CLIENT_SECRET || "").trim(),
	});
}

/**
 * Hosted context from a pushed overlay plus platform gates. Ignores env.OWNER_TOKEN and does not inherit secret
 * config from the Worker. Callers (the tenant DO) pass the overlay; the self-host fetch path never does.
 */
export function hostedTenantContext(env: WorkerBindings, overlay: HostedOverlay): TenantContext {
	const parsed = parseGates(env);
	// Operational caps default from the Worker; everything else, including every secret, comes only from the overlay.
	const config: ConfigFields = pickConfig(env, HOSTED_PLATFORM_DEFAULTS);
	for (const k of CONFIG_KEYS) {
		const v = overlay.config?.[k];
		if (typeof v === "string") config[k] = v;
	}
	const hash = (overlay.ownerTokenHash || "").trim().toLowerCase();
	// Hosted approval is the pushed tenant object only. Worker APPROVAL_OIDC_* does not approve a tenant.
	const approval = approvalFromRecord(overlay.approval);
	return new TenantContext({
		id: overlay.id, mode: "host", status: overlay.status || "active", db: overlay.db,
		publicUrl: overlay.publicUrl, gates: { ...parsed.gates, approvalOidc: approval.gate },
		limits: overlay.limits || {}, approval: approval.publicRecord,
		config, ownerTokenHash: hash || undefined, secretsKey: parsed.secretsKey,
		approvalClientSecret: approval.clientSecret,
	});
}
