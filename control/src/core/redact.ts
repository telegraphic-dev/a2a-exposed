// Secrets in logs and in values returned to a caller. Peer text is untrusted, so a
// normal field is copied through. A value is replaced only when its name is a secret,
// or when a name/value pair names one.

const REDACTED = "[redacted]";

const TOKEN_RE = /(?:a2aow_|s2a_|a2amcpr_|a2amcp_|a2aot_)[A-Za-z0-9_-]{20,}/g;
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?\s]*@/gi;
const BEARER_RE = /(bearer\s+)(\S{8,})/gi;
const BASIC_RE = /(basic\s+)(\S+)/gi;
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g;
const API_KEY_RE = /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\brk_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b)/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AUTH_RE = /\b((?:proxy-)?authorization)(\s*[:=]\s*)([^\n]+)/gi;
// Queries, fragment parameters, and form bodies share name=value encoding.
const QUERY_RE = /(^|[?&#\s])([^?&#\s="'<>]+)=("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:\\(?!["'])|[^&#\s"'<>\\])*)/g;
const ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)/g;

const SECRET_EXACT = new Set([
	"authorization",
	"proxyauthorization",
	"cookie",
	"setcookie",
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"clientsecret",
	"privatekey",
	"hmacsecret",
	"credential",
	"credentials",
	"bearer",
	"webhookkey",
	"accessclientid",
	"accessclientsecret",
]);

const SECRET_SUFFIX = [
	"authorization",
	"token",
	"secret",
	"password",
	"passwd",
	"credential",
	"credentials",
	"apikey",
	"clientsecret",
	"privatekey",
	"webhookkey",
	"accessclientid",
	"accessclientsecret",
	"cookie",
];

/** Decode form names without allowing malformed escapes to hide adjacent ASCII. */
function parameterName(name: string): string {
	return name.replace(/\+/g, " ").replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
		try { return decodeURIComponent(encoded); }
		catch {
			return encoded.replace(/%([0-7][0-9a-f])/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
		}
	});
}

function compactName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when this label is a credential, not a normal field such as name, key, url, or preset. */
function secretName(name: string): boolean {
	const compact = compactName(name);
	if (!compact || compact === "key" || compact === "name" || compact === "value" || compact === "id") return false;
	if (SECRET_EXACT.has(compact)) return true;
	return SECRET_SUFFIX.some((suffix) => compact.length > suffix.length && compact.endsWith(suffix));
}

function replaceAll(value: string, pattern: RegExp, replacement: string | ((...args: string[]) => string)): string {
	pattern.lastIndex = 0;
	return value.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
}

/** End index of a single- or double-quoted value, including its closer. `-1` when `start` is not a quote. An unclosed quote runs to the end. */
function quotedValueEnd(text: string, start: number): number {
	const quote = text[start];
	if (quote !== '"' && quote !== "'") return -1;
	for (let i = start + 1; i < text.length; i += 1) {
		if (text[i] === "\\") {
			i += 1;
			continue;
		}
		if (text[i] === quote) return i + 1;
	}
	return text.length;
}

function unquotedValueEnd(text: string, start: number): number {
	let i = start;
	while (i < text.length && !/\s/.test(text[i])) i += 1;
	return i;
}

/** A secret assignment loses its whole value. Quoted values, including escaped quotes, are read before an unquoted word. */
function redactAssignments(text: string): string {
	const pattern = new RegExp(ASSIGN_RE.source, "g");
	// Parameters were handled as complete name/value pairs; do not reinterpret
	// their names or consume following parameters as part of an assignment.
	const parameters = Array.from(text.matchAll(new RegExp(QUERY_RE.source, "g")));
	let parameter = 0;
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		while (parameter < parameters.length && parameters[parameter].index + parameters[parameter][0].length <= match.index) parameter += 1;
		if (parameter < parameters.length && parameters[parameter].index <= match.index) continue;
		const name = match[1] ?? "";
		if (!secretName(name)) continue;
		const sep = match[2] ?? "=";
		const valueStart = match.index + match[0].length;
		const quoted = quotedValueEnd(text, valueStart);
		const valueEnd = quoted >= 0 ? quoted : unquotedValueEnd(text, valueStart);
		out += text.slice(last, match.index);
		out += secretName(name) && valueEnd > valueStart ? `${name}${sep}${REDACTED}` : text.slice(match.index, valueEnd);
		last = valueEnd;
		pattern.lastIndex = valueEnd;
	}
	return out + text.slice(last);
}

/** Read one JSON value in log text without stopping at delimiters inside strings. */
function jsonValueEnd(text: string, start: number): number {
	if (text[start] === '"') return quotedValueEnd(text, start);
	if (text[start] === "[" || text[start] === "{") {
		const closers = [text[start] === "[" ? "]" : "}"];
		for (let i = start + 1; i < text.length; i += 1) {
			const char = text[i];
			if (char === '"') i = quotedValueEnd(text, i) - 1;
			else if (char === "[" || char === "{") closers.push(char === "[" ? "]" : "}");
			else if (char === closers[closers.length - 1]) {
				closers.pop();
				if (!closers.length) return i + 1;
			}
		}
		return text.length;
	}
	let end = start;
	while (end < text.length && !/[\s,}\]]/.test(text[end])) end += 1;
	return end;
}

/** Preserve surrounding log text and JSON formatting while removing complete secret values. */
function redactJsonFields(text: string, depth: number): string {
	let out = "";
	let last = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] !== '"') continue;
		const keyEnd = quotedValueEnd(text, i);
		let cursor = keyEnd;
		while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor += 1;
		if (text[cursor] === ":") {
			let name: string;
			try { name = JSON.parse(text.slice(i, keyEnd)); }
			catch { i = keyEnd - 1; continue; }
			if (secretName(name)) {
				cursor += 1;
				while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
				const end = jsonValueEnd(text, cursor);
				if (end > cursor) {
					out += text.slice(last, cursor) + JSON.stringify(REDACTED);
					last = end;
					i = end - 1;
					continue;
				}
			}
		}
		// JSON string values may contain another serialized document or URL.
		if (text[cursor] !== ":") {
			try {
				const decoded: string = JSON.parse(text.slice(i, keyEnd));
				const cleaned = redactNested(decoded, depth + 1);
				if (cleaned !== decoded) {
					out += text.slice(last, i) + JSON.stringify(cleaned);
					last = keyEnd;
				}
			} catch { /* Text passes also inspect malformed log strings. */ }
		}
		i = keyEnd - 1;
	}
	return out + text.slice(last);
}

/** Inspect encoded containers, preserving their encoding when unchanged. */
function redactNested(value: string, depth: number): string {
	// Fail closed on excessively nested untrusted input, without overflowing.
	if (depth >= 64) return REDACTED;
	const text = redactText(value, depth);
	if (text !== value) return text;
	const decoded = parameterName(value);
	if (decoded !== value) {
		const cleaned = redactNested(decoded, depth + 1);
		if (cleaned !== decoded) return encodeURIComponent(cleaned);
	}
	return value;
}

/** Remove secret text. The words around it stay. */
function redactText(value: string, depth = 0): string {
	let text = redactJsonFields(value, depth);
	text = replaceAll(text, PEM_RE, REDACTED);
	text = replaceAll(text, JWT_RE, REDACTED);
	text = replaceAll(text, API_KEY_RE, REDACTED);
	text = replaceAll(text, TOKEN_RE, REDACTED);
	text = replaceAll(text, BEARER_RE, `$1${REDACTED}`);
	text = replaceAll(text, BASIC_RE, `$1${REDACTED}`);
	text = replaceAll(text, AUTH_RE, (_all, name: string, sep: string, rest: string) => {
		if (rest.trim().length < 8 && !/bearer|basic/i.test(rest)) return `${name}${sep}${rest}`;
		return `${name}${sep}${REDACTED}`;
	});
	text = replaceAll(text, USERINFO_RE, `$1${REDACTED}@`);
	const cleanParameter = (all: string, sep: string, name: string, item: string): string => {
		let decoded = name;
		// Each decoding step shortens an escaped name; repeated encoding must
		// not turn a credential label into an ordinary container.
		while (true) {
			const next = parameterName(decoded);
			if (next === decoded) break;
			decoded = next;
		}
		let setup = false;
		if (decoded.trim().toLowerCase() === "t") {
			let candidate = item.replace(/^["']|["']$/g, "");
			while (true) {
				const next = parameterName(candidate);
				if (next === candidate) break;
				candidate = next;
			}
			setup = /^[A-Za-z0-9_-]{16,}/.test(candidate);
		}
		if (!item) return all;
		if (!secretName(decoded) && !setup) return `${sep}${name}=${redactNested(item, depth + 1)}`;
		return `${sep}${name}=${REDACTED}`;
	};
	const parameters = new RegExp(QUERY_RE.source, "g");
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = parameters.exec(text)) !== null) {
		const cleaned = cleanParameter(match[0], match[1], match[2], match[3]);
		if (cleaned === match[0]) {
			// An ordinary container is not evidence that its contents are safe.
			// Inspect nested delimiters even when its value ends at a quote.
			parameters.lastIndex = match.index + match[1].length + match[2].length + 1;
			continue;
		}
		out += text.slice(last, match.index) + cleaned;
		last = parameters.lastIndex;
	}
	text = out + text.slice(last);

	text = redactAssignments(text);

	return text;
}

function own(record: Record<string, unknown>, name: string): { key: string; value: unknown } | null {
	for (const key of Object.keys(record)) {
		if (key.toLowerCase() === name) return { key, value: record[key] };
	}
	return null;
}

function pairLabel(record: Record<string, unknown>): string {
	const name = own(record, "name");
	const key = own(record, "key");
	if (name && typeof name.value === "string" && secretName(name.value)) return name.value;
	if (key && typeof key.value === "string" && secretName(key.value)) return key.value;
	return "";
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactText(value);
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return REDACTED;
	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length === 2 && typeof value[0] === "string" && secretName(value[0])) return [value[0], REDACTED];
		return value.map((item) => walk(item, seen));
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const record = value as Record<string, unknown>;
	const hidden = new Set<string>();
	const valueField = own(record, "value");
	if (valueField && pairLabel(record)) hidden.add(valueField.key);
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (hidden.has(key) || secretName(key)) {
			out[key] = REDACTED;
			continue;
		}
		out[key] = walk(item, seen);
	}
	return out;
}

/**
 * Copy `value` with secrets removed.
 * A `{ name, value }` or `{ key, value }` pair, and a `[name, value]` pair, lose `value`
 * when that name is a secret. A pair whose name is an ordinary field stays.
 */
export function sanitized<T>(value: T): T {
	return walk(value, new WeakSet()) as T;
}

/** Remove secrets from text. An object is copied with {@link sanitized}. */
export function redact(value: string): string;
export function redact(value: unknown): unknown;
export function redact(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	return sanitized(value);
}
