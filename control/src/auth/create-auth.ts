import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth, magicLink } from "better-auth/plugins";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { CLI_CLIENT_ID } from "./device.ts";
import { jwt } from "better-auth/plugins/jwt";
import { CLOUDFLARE_FETCH_MS, readCloudflare } from "./cloudflare-link.ts";
import { mapCloudflareUser } from "./cloudflare-user.ts";
import { INVITE_COOKIE, SESSION_COOKIE, readCookie } from "./cookies.ts";
import { emailAllowed, emailIsVerified } from "./allowlist.ts";
import { consumeInvite, rememberMagicInvite, takeMagicInvite, validInviteCode } from "./invites.ts";
import type { AuthOptions } from "./options.ts";
import { cloudflareMailer } from "../mail/cloudflare.ts";
import type { Mailer } from "../mail/types.ts";

// Better Auth links when the provider is trusted or the profile says the email
// is verified, and only onto an account whose email is already verified. The
// list stays empty: a trusted provider would attach an address that provider
// did not verify. GitHub links when its primary email is `verified`. Google
// links when `email_verified` is true. A magic link is verified because the
// link was received. Cloudflare is not in this list. Its email is never
// verified, so it does not auto-link and does not match SIGNUP_ALLOWLIST.
// A signed-in account connects it explicitly; later sign-in uses the account id.
export const TRUSTED_PROVIDERS: string[] = [];

const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const USER = "https://api.cloudflare.com/client/v4/user";

async function mailerFor(options: AuthOptions): Promise<Mailer | undefined> {
	if (options.mailer) return options.mailer;
	if (!options.emailBinding || !options.mailFrom) return undefined;
	return cloudflareMailer(options.emailBinding, options.mailFrom);
}

export async function createAuth(options: AuthOptions) {
	const mailer = await mailerFor(options);
	const plugins = [];
	if (options.cloudflare) {
		plugins.push(genericOAuth({
			config: [{
				providerId: "cloudflare",
				clientId: options.cloudflare.clientId,
				clientSecret: options.cloudflare.clientSecret,
				authorizationUrl: AUTHORIZE,
				tokenUrl: TOKEN,
				scopes: ["user-details.read"],
				pkce: true,
				disableSignUp: true,
				accountSubject: ({ profile }) => typeof profile.id === "string" ? profile.id.trim() : "",
				async getUserInfo(tokens) {
					const accessToken = tokens.accessToken;
					if (!accessToken) return null;
					const profile = await readCloudflare(USER, {
						headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
					}, CLOUDFLARE_FETCH_MS);
					if (profile.kind !== "ok" || !profile.body || typeof profile.body !== "object") return null;
					const body = profile.body as { result?: Parameters<typeof mapCloudflareUser>[0] };
					return mapCloudflareUser(body.result);
				},
			}],
		}));
	}
	if (mailer) {
		plugins.push(magicLink({
			expiresIn: 60 * 5,
			storeToken: "hashed",
			async sendMagicLink({ email, url, token, metadata }) {
				const code = typeof metadata?.invite === "string" ? metadata.invite : "";
				if (token && validInviteCode(code)) await rememberMagicInvite(options.database, token, code, email, 60 * 5);
				await mailer.send({
					to: email,
					subject: "Sign in",
					text: `Sign in:\n${url}\n\nIf you did not ask for this, ignore this email.\n`,
				});
			},
		}));
	}
	plugins.push(deviceAuthorization({
		verificationUri: "/app/device",
		expiresIn: "10m",
		validateClient: (clientId) => clientId === CLI_CLIENT_ID,
	}));
	// The device token is the raw session token. Bearer signs it for this request
	// so the CLI can call /api/auth/get-session without the auth secret.
	plugins.push(bearer());
	// RS256 is what the data plane's approval client accepts. Session responses do not carry a JWT.
	plugins.push(jwt({
		disableSettingJwtHeader: true,
		jwks: { keyPairConfig: { alg: "RS256" } },
		jwt: { issuer: options.baseURL, audience: options.baseURL, expirationTime: "10m" },
	}));
	return betterAuth({
		baseURL: options.baseURL,
		basePath: "/api/auth",
		secret: options.secret,
		// Callback failures land on the sign-in page. Without this, production sends
		// `/api/auth/error` to `/?error=`, which does not show the sign-in message.
		// Better Auth appends `?error=<code>`. A query that already sets `error`
		// hides that code, because the page reads the first value.
		onAPIError: { errorURL: `${options.baseURL}/app` },
		database: options.database,
		emailAndPassword: { enabled: false },
		socialProviders: {
			...(options.github ? { github: options.github } : {}),
			...(options.google ? { google: options.google } : {}),
		},
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: TRUSTED_PROVIDERS,
			},
		},
		advanced: {
			useSecureCookies: false,
			crossSubDomainCookies: { enabled: false },
			defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
			cookies: { session_token: { name: SESSION_COOKIE } },
			database: { validateSchema: false },
			// Cloudflare sets this. Sign-in copies it onto the Better Auth request.
			// Without a client address, production limits every visitor together:
			// three sign-ins per ten seconds, then 429.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
		user: {
			// Fresh provider profile, including a later sign-in. An unverified address never matches.
			// Trust is per provider. GitHub uses `verified` and Google uses `email_verified`.
			// Cloudflare's email is never that flag. A linked Cloudflare sign-in is admitted
			// here; the session hook still checks the stored account, not the Cloudflare email.
			validateUserInfo: async (info: { user: { email?: unknown; emailVerified?: unknown }; source?: { action?: string; oauth?: { providerId?: string } } }) => {
				const provider = info.source?.oauth?.providerId;
				if (provider === "cloudflare") {
					if (info.source?.action === "sign-in") return;
					return { error: "cloudflare_unlinked" };
				}
				if (!options.signupAllowlist) return;
				const email = typeof info.user.email === "string" ? info.user.email : "";
				if (!emailAllowed(options.signupAllowlist, email, emailIsVerified(info.user.emailVerified))) return { error: "invite" };
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user, context) => {
						if (!options.invitesRequired) return;
						const email = typeof user.email === "string" ? user.email : "";
						const request = context?.request ?? null;
						const token = request ? new URL(request.url).searchParams.get("token") ?? "" : "";
						const fromLink = email && token ? await takeMagicInvite(options.database, token, email) : "";
						const code = fromLink || readCookie(request?.headers.get("cookie") ?? null, INVITE_COOKIE);
						const accepted = email ? await consumeInvite(options.database, code, email) : false;
						if (!accepted) throw new APIError("FORBIDDEN", { message: "Invite required", code: "INVITE_REQUIRED" });
					},
				},
			},
			session: {
				create: {
					// Returning magic-link and CLI device sessions do not pass validateUserInfo.
					before: async (session) => {
						if (!options.signupAllowlist) return;
						const userId = typeof session.userId === "string" ? session.userId : "";
						const row = userId
							? await options.database.prepare(
								`SELECT email, "emailVerified" AS email_verified FROM "user" WHERE id = ?`,
							).bind(userId).first<{ email: string; email_verified: number | boolean }>()
							: null;
						if (!row || !emailAllowed(options.signupAllowlist, row.email, emailIsVerified(row.email_verified))) {
							throw new APIError("FORBIDDEN", { message: "Invite required", code: "invite" });
						}
					},
				},
			},
		},
		plugins,
	});
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
