export interface ApprovalClient {
	clientId: string;
	secretHash: string;
	redirectUris: string[];
	clientSecret: string;
	approval: Record<string, unknown>;
}

/** https origin, or "" when the value is empty, not https, or carries userinfo. */
export function httpsOrigin(value: string | undefined): string {
	const raw = (value || "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return url.origin;
	} catch {
		return "";
	}
}

function bytes(size: number): Uint8Array {
	const out = new Uint8Array(size);
	crypto.getRandomValues(out);
	return out;
}

function b64url(data: Uint8Array): string {
	let raw = "";
	for (const byte of data) raw += String.fromCharCode(byte);
	return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buttonLabel(value: string | undefined): string {
	const label = (value || "").trim();
	if (!label || label.length > 40 || /[\u0000-\u001f<>]/.test(label)) return "";
	return label;
}

function callbackUris(publicUrl: string | null): string[] {
	if (!publicUrl) return [];
	try {
		const url = new URL(publicUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return [];
	} catch {
		return [];
	}
	return [`${publicUrl}/device/oidc/callback`, `${publicUrl}/oauth/authorize/oidc/callback`];
}

/** Confidential client for one tenant. Null when there is no https issuer or public host. */
export async function newApprovalClient(input: {
	accountId: string;
	issuer: string;
	publicUrl: string | null;
	label?: string;
}): Promise<ApprovalClient | null> {
	const issuer = httpsOrigin(input.issuer);
	const redirectUris = callbackUris(input.publicUrl);
	if (!issuer || !redirectUris.length) return null;
	const clientId = `a2ac_${b64url(bytes(16))}`;
	const clientSecret = `a2acs_${b64url(bytes(32))}`;
	const label = buttonLabel(input.label);
	const approval: Record<string, unknown> = {
		issuer,
		clientId,
		clientSecret,
		allowedSubjects: [input.accountId],
		methods: ["oidc"],
	};
	if (label) approval.label = label;
	return { clientId, clientSecret, secretHash: await sha256(clientSecret), redirectUris, approval };
}
