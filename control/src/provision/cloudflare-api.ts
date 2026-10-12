// Cloudflare REST calls for "Set me up on Cloudflare". The control Worker cannot run `cf`.
// These are the same resources `cf deploy` creates for an inbox: account, D1, migrations,
// the Worker script, workers.dev, or a custom hostname. The access token is a header only.

const API = "https://api.cloudflare.com/client/v4";

export interface CfApiError {
	code: number | null;
	message: string;
}

export interface CfFailure {
	ok: false;
	status: number;
	/** First numeric code in `errors`, or null. */
	code: number | null;
	/** Sanitised Cloudflare `errors` array. Empty when the call throws first. */
	errors: CfApiError[];
	/** Set when fetch throws before a response. The message is sanitised. */
	thrown?: { name: string; message: string };
}

export interface CfSuccess {
	ok: true;
	status: number;
	body: unknown;
}

export type CfResponse = CfSuccess | CfFailure;

/** Query names whose values are credentials. `authorization server` has neither, so it stays. */
const SECRET_PARAM = /\b(?:id_token|access_token|refresh_token|client_secret|authorization|code|token)\s*(?:=|%3d|:)\s*\S/i;
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

/** A short Cloudflare message with tokens, bearer values, and JWTs removed. */
export function sanitizeCloudflareText(value: string): string {
	const cleaned = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
	if (!cleaned) return "";
	if (SECRET_PARAM.test(cleaned) || /bearer\s+\S/i.test(cleaned) || JWT_SHAPED.test(cleaned)) return "redacted";
	return cleaned;
}

/**
 * Workers throw `TypeError: Invalid header value` before any HTTP response when the
 * bearer token contains CR, LF, or NUL. Those bytes are not part of the token.
 */
export function headerSafeToken(token: string): string {
	return token.replace(/[\r\n\u0000]/g, "").trim();
}

function numericCode(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(item: object): string {
	const record = item as { message?: unknown; error_chain?: unknown };
	const parts: string[] = [];
	if (typeof record.message === "string") parts.push(record.message);
	if (Array.isArray(record.error_chain)) {
		for (const link of record.error_chain) {
			if (!link || typeof link !== "object") continue;
			const message = (link as { message?: unknown }).message;
			if (typeof message === "string") parts.push(message);
		}
	}
	return sanitizeCloudflareText(parts.join(" — "));
}

export function cloudflareErrors(body: unknown): CfApiError[] {
	if (!body || typeof body !== "object") return [];
	const errors = (body as { errors?: unknown }).errors;
	if (!Array.isArray(errors)) return [];
	const out: CfApiError[] = [];
	for (const item of errors.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		out.push({ code: numericCode((item as { code?: unknown }).code), message: errorText(item) });
	}
	return out;
}

function failureFrom(status: number, body: unknown, thrown?: { name: string; message: string }): CfFailure {
	const errors = cloudflareErrors(body);
	return { ok: false, status, code: errors.find((error) => error.code != null)?.code ?? null, errors, ...(thrown ? { thrown } : {}) };
}

function thrownFailure(error: unknown): CfFailure {
	const name = error instanceof Error && error.name ? error.name.slice(0, 80) : "Error";
	const message = sanitizeCloudflareText(error instanceof Error ? error.message : "");
	return { ok: false, status: 0, code: null, errors: [], thrown: { name, message } };
}

/** True when this response means the account has no workers.dev name yet. */
export function subdomainMissing(failure: CfFailure): boolean {
	if (failure.status === 404) return true;
	return failure.errors.some((error) =>
		error.code === 10063
		|| error.code === 10007
		|| (/workers\.dev/i.test(error.message) && /subdomain|register|not found|does not have/i.test(error.message)));
}

/** Plain words for the page and for a stored note. No tokens. */
export function describeCfFailure(failure: CfFailure): string {
	if (failure.thrown) {
		const detail = failure.thrown.message && failure.thrown.message !== "redacted"
			? `${failure.thrown.name}: ${failure.thrown.message}`
			: failure.thrown.name;
		return `The request stops before Cloudflare answers (${detail}).`;
	}
	const parts: string[] = [];
	for (const error of failure.errors) {
		if (error.message === "redacted") {
			parts.push(error.code != null
				? `code ${error.code}. Cloudflare's message is hidden because it contains a secret.`
				: "Cloudflare's message is hidden because it contains a secret.");
		} else if (error.code != null && error.message) parts.push(`code ${error.code}: ${error.message}`);
		else if (error.code != null) parts.push(`code ${error.code}`);
		else if (error.message) parts.push(error.message);
	}
	if (parts.length) return `Cloudflare says ${parts.join("; ")}.`;
	if (failure.status) return `Cloudflare answers HTTP ${failure.status}.`;
	return "The request stops before Cloudflare answers.";
}

/**
 * Workers throw `TypeError: Illegal invocation` before any response when `fetch`
 * is called as a bare function (`const send = fetch; send(url)`). The receiver
 * has to be the global object, which is how a direct `fetch()` call behaves.
 */
export function callFetch(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
	return fetchImpl.call(globalThis, url, init);
}

/** One Cloudflare API call. A redirect is a failure: the token must not follow to another host. */
export async function cfCall(input: {
	fetchImpl: typeof fetch;
	token: string;
	method: string;
	path: string;
	json?: unknown;
	raw?: { body: BodyInit; contentType: string };
	fetchMs: number;
}): Promise<CfResponse> {
	const method = input.method.toUpperCase();
	let body: BodyInit | undefined;
	const headers = new Headers({ accept: "application/json" });
	try {
		headers.set("authorization", `Bearer ${headerSafeToken(input.token)}`);
	} catch (error) {
		return thrownFailure(error);
	}
	if (input.raw) {
		headers.set("content-type", input.raw.contentType);
		body = input.raw.body;
	} else if (input.json !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(input.json);
	}
	// A GET or HEAD with a body throws in Workers before any response. Omit the field.
	const init: RequestInit = {
		method,
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(input.fetchMs),
	};
	if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = body;
	let response: Response;
	try {
		response = await callFetch(input.fetchImpl, `${API}${input.path}`, init);
	} catch (error) {
		return thrownFailure(error);
	}
	if (response.status >= 300 && response.status < 400) {
		void response.body?.cancel().catch(() => {});
		return failureFrom(response.status, null);
	}
	const text = await response.text().catch(() => "");
	let parsed: unknown = null;
	if (text) {
		try { parsed = JSON.parse(text); } catch { parsed = null; }
	}
	const success = parsed && typeof parsed === "object" ? (parsed as { success?: unknown }).success : undefined;
	if (!response.ok || success === false) return failureFrom(response.status, parsed);
	return { ok: true, status: response.status, body: parsed };
}

export function resultObject(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object") return null;
	const result = (body as { result?: unknown }).result;
	return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
}

export function resultList(body: unknown): Record<string, unknown>[] {
	if (!body || typeof body !== "object") return [];
	const result = (body as { result?: unknown }).result;
	if (!Array.isArray(result)) return [];
	return result.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

/** Rows from a D1 `/query` response. */
export function d1Rows(body: unknown): Record<string, unknown>[] {
	const list = resultList(body);
	const first = list[0];
	const rows = first?.results;
	if (!Array.isArray(rows)) return [];
	return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

export interface CfAccount {
	id: string;
	name: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function listAccounts(input: { fetchImpl: typeof fetch; token: string; fetchMs: number }): Promise<CfAccount[] | CfFailure> {
	const read = await cfCall({ ...input, method: "GET", path: "/accounts?per_page=50" });
	if (!read.ok) return read;
	const accounts: CfAccount[] = [];
	for (const row of resultList(read.body)) {
		const id = typeof row.id === "string" ? row.id : "";
		const name = typeof row.name === "string" ? row.name : id;
		if (!ID_RE.test(id)) continue;
		accounts.push({ id, name: name.slice(0, 120) });
	}
	return accounts;
}

export async function workersDevSubdomain(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }): Promise<string | CfFailure> {
	const read = await cfCall({ ...input, method: "GET", path: `/accounts/${input.accountId}/workers/subdomain` });
	if (!read.ok) return read.status === 404 ? "" : read;
	const name = resultObject(read.body)?.subdomain;
	return typeof name === "string" ? name.trim().toLowerCase() : "";
}

export async function registerWorkersDevSubdomain(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; subdomain: string }): Promise<true | CfFailure> {
	const read = await cfCall({
		...input,
		method: "PUT",
		path: `/accounts/${input.accountId}/workers/subdomain`,
		json: { subdomain: input.subdomain },
	});
	return read.ok ? true : read;
}

export interface D1Database {
	uuid: string;
	name: string;
}

export async function findD1(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; name: string }): Promise<D1Database | null | CfFailure> {
	const read = await cfCall({ ...input, method: "GET", path: `/accounts/${input.accountId}/d1/database?per_page=100` });
	if (!read.ok) return read;
	for (const row of resultList(read.body)) {
		const uuid = typeof row.uuid === "string" ? row.uuid : "";
		const name = typeof row.name === "string" ? row.name : "";
		if (name === input.name && ID_RE.test(uuid)) return { uuid, name };
	}
	return null;
}

export async function createD1(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; name: string }): Promise<D1Database | CfFailure> {
	const read = await cfCall({
		...input,
		method: "POST",
		path: `/accounts/${input.accountId}/d1/database`,
		json: { name: input.name },
	});
	if (!read.ok) return read;
	const row = resultObject(read.body);
	const uuid = typeof row?.uuid === "string" ? row.uuid : "";
	if (!ID_RE.test(uuid)) return failureFrom(read.status, null);
	return { uuid, name: input.name };
}

export async function d1Query(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; databaseId: string; sql: string; params?: unknown[] }): Promise<Record<string, unknown>[] | CfFailure> {
	const read = await cfCall({
		...input,
		method: "POST",
		path: `/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
		json: input.params ? { sql: input.sql, params: input.params } : { sql: input.sql },
	});
	if (!read.ok) return read;
	return d1Rows(read.body);
}

/** Plain-text setting this page writes. The script source is not proof of ownership. */
export const PROVISION_TAG_NAME = "A2A_PROVISION_TAG";

/**
 * The provision tag on this script. `null` when the script does not exist.
 * An empty string means the script is there and does not carry this page's tag.
 * The script body is not read: a comment in the source is not this value.
 */
export async function workerProvisionTag(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; name: string }): Promise<string | null | CfFailure> {
	const settings = await cfCall({ ...input, method: "GET", path: `/accounts/${input.accountId}/workers/scripts/${input.name}/settings` });
	if (!settings.ok) return settings.status === 404 ? null : settings;
	const bindings = resultObject(settings.body)?.bindings;
	if (!Array.isArray(bindings)) return "";
	for (const binding of bindings) {
		if (!binding || typeof binding !== "object") continue;
		const row = binding as { type?: unknown; name?: unknown; text?: unknown };
		if (row.type !== "plain_text" || row.name !== PROVISION_TAG_NAME || typeof row.text !== "string") continue;
		return row.text;
	}
	return "";
}

/** Module-syntax script upload. `metadata` carries the D1 binding and the owner token. */
export function workerUploadBody(input: { script: string; metadata: unknown }): { body: string; contentType: string } {
	const boundary = `a2a${crypto.randomUUID().replace(/-/g, "")}`;
	const meta = JSON.stringify(input.metadata);
	const body = [
		`--${boundary}`,
		`Content-Disposition: form-data; name="metadata"`,
		`Content-Type: application/json`,
		``,
		meta,
		`--${boundary}`,
		`Content-Disposition: form-data; name="index.js"; filename="index.js"`,
		`Content-Type: application/javascript+module`,
		``,
		input.script,
		`--${boundary}--`,
		``,
	].join("\r\n");
	return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadWorker(input: {
	fetchImpl: typeof fetch;
	token: string;
	fetchMs: number;
	accountId: string;
	name: string;
	script: string;
	metadata: unknown;
}): Promise<true | CfFailure> {
	const raw = workerUploadBody({ script: input.script, metadata: input.metadata });
	const read = await cfCall({
		fetchImpl: input.fetchImpl,
		token: input.token,
		method: "PUT",
		path: `/accounts/${input.accountId}/workers/scripts/${input.name}`,
		raw,
		fetchMs: input.fetchMs,
	});
	return read.ok ? true : read;
}

export async function setWorkersDevEnabled(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; name: string; enabled: boolean }): Promise<true | CfFailure> {
	const read = await cfCall({
		...input,
		method: "POST",
		path: `/accounts/${input.accountId}/workers/scripts/${input.name}/subdomain`,
		json: { enabled: input.enabled, previews_enabled: false },
	});
	return read.ok ? true : read;
}

export interface CfZone {
	id: string;
	name: string;
	status: string;
}

export async function listZones(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string }): Promise<CfZone[] | CfFailure> {
	const read = await cfCall({
		...input,
		method: "GET",
		path: `/zones?account.id=${input.accountId}&per_page=50`,
	});
	if (!read.ok) return read;
	const zones: CfZone[] = [];
	for (const row of resultList(read.body)) {
		const id = typeof row.id === "string" ? row.id : "";
		const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
		const status = typeof row.status === "string" ? row.status : "";
		if (!ID_RE.test(id) || !name) continue;
		zones.push({ id, name, status });
	}
	return zones;
}

/** Attaches the Worker to a hostname. Cloudflare creates the DNS record for that name. */
export async function attachHostname(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; workerName: string; hostname: string; zoneId: string }): Promise<true | CfFailure> {
	const read = await cfCall({
		...input,
		method: "PUT",
		path: `/accounts/${input.accountId}/workers/domains`,
		json: { hostname: input.hostname, service: input.workerName, environment: "production", zone_id: input.zoneId },
	});
	return read.ok ? true : read;
}
