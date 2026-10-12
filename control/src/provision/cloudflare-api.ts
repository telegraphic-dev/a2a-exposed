// Cloudflare REST calls for "Set me up on Cloudflare". The control Worker cannot run `cf`.
// These are the same resources `cf deploy` creates for an inbox: account, D1, migrations,
// the Worker script, workers.dev, or a custom hostname. The access token is a header only.

const API = "https://api.cloudflare.com/client/v4";

export interface CfFailure {
	ok: false;
	status: number;
	code: number | null;
}

export interface CfSuccess {
	ok: true;
	status: number;
	body: unknown;
}

export type CfResponse = CfSuccess | CfFailure;

function errorCode(body: unknown): number | null {
	if (!body || typeof body !== "object") return null;
	const errors = (body as { errors?: unknown }).errors;
	const first = Array.isArray(errors) ? errors[0] : null;
	const code = first && typeof first === "object" ? (first as { code?: unknown }).code : null;
	return typeof code === "number" ? code : null;
}

/** One Cloudflare API call. A redirect is a failure: the token must not follow to another host. */
export async function cfCall(input: {
	fetchImpl: typeof fetch;
	token: string;
	method: string;
	path: string;
	json?: unknown;
	raw?: { body: BodyInit; contentType: string };
	/** Return the response body as text. Used to read a Worker script, which is not JSON. */
	asText?: boolean;
	fetchMs: number;
}): Promise<CfResponse> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${input.token}`,
		accept: input.asText ? "*/*" : "application/json",
	};
	let body: BodyInit | undefined;
	if (input.raw) {
		headers["content-type"] = input.raw.contentType;
		body = input.raw.body;
	} else if (input.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(input.json);
	}
	const timeout = AbortSignal.timeout(input.fetchMs);
	let response: Response;
	try {
		response = await input.fetchImpl(`${API}${input.path}`, {
			method: input.method,
			headers,
			body,
			redirect: "manual",
			signal: timeout,
		});
	} catch {
		return { ok: false, status: 0, code: null };
	}
	if (response.status >= 300 && response.status < 400) {
		void response.body?.cancel().catch(() => {});
		return { ok: false, status: response.status, code: null };
	}
	const text = await response.text().catch(() => "");
	if (input.asText) return response.ok ? { ok: true, status: response.status, body: text } : { ok: false, status: response.status, code: null };
	let parsed: unknown = null;
	if (text) {
		try { parsed = JSON.parse(text); } catch { parsed = null; }
	}
	const code = errorCode(parsed);
	const success = parsed && typeof parsed === "object" ? (parsed as { success?: unknown }).success : undefined;
	if (!response.ok || success === false) return { ok: false, status: response.status, code };
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
	if (!ID_RE.test(uuid)) return { ok: false, status: read.status, code: null };
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

/** The banner `bundle-inbox.mjs` writes. A script without it was not uploaded by this page. */
export const INBOX_SCRIPT_MARKER = "a2a-exposed inbox";

/**
 * Whether the named Worker is absent, the inbox this page uploaded, or someone else's script.
 * A saved database id is not proof: a later retry must not replace a Worker it did not create.
 */
export async function inboxScriptOwnership(input: { fetchImpl: typeof fetch; token: string; fetchMs: number; accountId: string; name: string }): Promise<"missing" | "ours" | "other" | CfFailure> {
	const settings = await cfCall({ ...input, method: "GET", path: `/accounts/${input.accountId}/workers/scripts/${input.name}/settings` });
	if (!settings.ok) return settings.status === 404 ? "missing" : settings;
	const script = await cfCall({ ...input, method: "GET", path: `/accounts/${input.accountId}/workers/scripts/${input.name}`, asText: true });
	if (!script.ok) return script.status === 404 ? "missing" : script;
	const body = typeof script.body === "string" ? script.body : "";
	return body.includes(INBOX_SCRIPT_MARKER) ? "ours" : "other";
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
