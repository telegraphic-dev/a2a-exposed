import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha, genericOAuth, magicLink } from "better-auth/plugins";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { CLI_CLIENT_ID } from "./device.ts";
import { jwt } from "better-auth/plugins/jwt";
import { mapCloudflareUser } from "./cloudflare-user.ts";
import { INVITE_COOKIE, SESSION_COOKIE, readCookie } from "./cookies.ts";
import { consumeInvite, rememberMagicInvite, takeMagicInvite, validInviteCode } from "./invites.ts";
import type { AuthOptions } from "./options.ts";
import { cloudflareMailer } from "../mail/cloudflare.ts";
import type { Mailer } from "../mail/types.ts";

// Better Auth links when the provider is trusted OR the profile says the email
// is verified. A trusted provider would therefore link an unverified address.
// The list stays empty so only a provider-verified email (GitHub primary
// `verified`, Google `email_verified`, or a magic link) can attach to an
// existing account. Cloudflare is mapped with emailVerified false.
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
				async getUserInfo(tokens) {
					const accessToken = tokens.accessToken;
					if (!accessToken) return null;
					const response = await fetch(USER, { headers: { authorization: `Bearer ${accessToken}` } });
					if (!response.ok) return null;
					const body = await response.json() as { result?: Parameters<typeof mapCloudflareUser>[0] };
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
	if (options.turnstile) {
		plugins.push(captcha({
			provider: "cloudflare-turnstile",
			secretKey: options.turnstile.secret,
			endpoints: ["/sign-in/magic-link", "/sign-in/social"],
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
		},
		plugins,
	});
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
