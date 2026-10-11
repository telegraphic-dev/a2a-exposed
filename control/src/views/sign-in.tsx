const PROVIDERS = [
	["github", "Continue with GitHub"],
	["google", "Continue with Google"],
	["cloudflare", "Continue with Cloudflare"],
] as const;

function ProviderMark(props: { id: "github" | "google" | "cloudflare" }) {
	if (props.id === "github") {
		return (
			<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
				<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
			</svg>
		);
	}
	if (props.id === "google") {
		return (
			<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
				<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
				<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
				<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
				<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
			</svg>
		);
	}
	return (
		<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
			<path fill="currentColor" d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727" />
		</svg>
	);
}

const ERRORS: Record<string, string> = {
	invite: "That invite code is not valid.",
	INVITE_REQUIRED: "That invite code is not valid.",
	turnstile: "Wait for the check to finish, then try again.",
	"invalid-input-response": "The check failed. Try again.",
	"missing-input-response": "The check failed. Try again.",
	"bad-request": "The check failed. Try again.",
	"timeout-or-duplicate": "The check expired. Please try again.",
	"invalid-input-secret": "The sign-in check is not configured.",
	"missing-input-secret": "The sign-in check is not configured.",
	turnstile_unavailable: "The check could not be completed.",
	UNKNOWN_ERROR: "The check could not be completed.",
	rate_limit: "Too many sign-in attempts. Try again in a moment.",
	provider_url: "The provider address was rejected.",
	origin: "Sign-in did not complete.",
	INVALID_ORIGIN: "This site cannot start sign-in.",
	MISSING_OR_NULL_ORIGIN: "This site cannot start sign-in.",
	PROVIDER_NOT_FOUND: "That login provider is not available.",
	INVALID_CALLBACK_URL: "Sign-in did not complete.",
	INVALID_ERROR_CALLBACK_URL: "Sign-in did not complete.",
	email: "Enter an email address.",
	auth: "Sign-in did not complete.",
	unavailable: "Login is not available.",
	deadline: "Sign-in took too long. Try again.",
	state_mismatch: "Sign-in expired. Try again.",
	state_not_found: "Sign-in expired. Try again.",
	state_invalid: "Sign-in expired. Try again.",
	please_restart_the_process: "Sign-in expired. Try again.",
	INVALID_TOKEN: "That sign-in link is not valid. Try again.",
	access_denied: "Sign-in was cancelled.",
	invalid_code: "The provider rejected the sign-in. Try again.",
	no_code: "The provider did not finish sign-in. Try again.",
	invalid_callback_request: "Sign-in did not complete. Try again.",
	email_not_found: "That account has no email address.",
	email_not_verified: "That email is not verified.",
	email_does_not_match: "That email does not match the account.",
	unable_to_get_user_info: "The provider did not return an account.",
	unable_to_create_user: "The account could not be created.",
	failed_to_create_user: "The account could not be created.",
	unable_to_create_session: "The session could not be created.",
	failed_to_create_session: "The session could not be created.",
	unable_to_link_account: "That account could not be linked.",
	unable_to_update_account: "That account could not be linked.",
	account_not_linked: "That account is not linked.",
	account_already_linked_to_different_user: "That account is already linked to someone else.",
	user_not_found: "That account could not be found.",
	signup_disabled: "New accounts are not accepted.",
	new_user_signup_disabled: "New accounts are not accepted.",
	oauth_provider_not_found: "That login provider is not available.",
	issuer_mismatch: "The provider identity did not match.",
	issuer_missing: "The provider identity did not match.",
	nonce_binding_missing: "The provider identity did not match.",
	no_callback_url: "Sign-in did not complete. Try again.",
};

export function renderSignIn(input: {
	providers: string[];
	magicLink: boolean;
	invitesRequired: boolean;
	turnstileSiteKey?: string;
	notice?: string;
	error?: string;
	sent?: boolean;
}): string {
	const error = input.error ? ERRORS[input.error] ?? ERRORS.auth : "";
	const buttons = PROVIDERS.filter(([id]) => input.providers.includes(id));
	return (
		<div>
			{input.notice ? <p>{input.notice}</p> : ""}
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{input.sent ? <p>Check your email for a sign-in link.</p> : ""}
			<form method="post" action="/app/sign-in">
				{input.invitesRequired ? (
					<p>
						<label>
							Invite code <span>Required the first time you sign in.</span>
							<input name="invite" autocomplete="off" />
						</label>
					</p>
				) : ""}
				{input.magicLink ? (
					<p>
						<label>
							Email
							<input name="email" type="email" autocomplete="username" />
						</label>
					</p>
				) : ""}
				{input.turnstileSiteKey ? (
					<div
						class="cf-turnstile"
						data-sitekey={input.turnstileSiteKey}
						data-callback="a2aTurnstileReady"
						data-expired-callback="a2aTurnstileWait"
						data-error-callback="a2aTurnstileWait"
					/>
				) : ""}
				{input.turnstileSiteKey ? <p class="check-wait">Waiting for the check…</p> : ""}
				<p class="providers">
					{buttons.map(([id, label]) => input.turnstileSiteKey
						? <button class={`provider provider-${id}`} name="provider" value={id} type="submit" disabled><ProviderMark id={id} />{label}</button>
						: <button class={`provider provider-${id}`} name="provider" value={id} type="submit"><ProviderMark id={id} />{label}</button>)}
					{input.magicLink ? input.turnstileSiteKey
						? <button class="provider provider-email" name="provider" value="email" type="submit" disabled>Email</button>
						: <button class="provider provider-email" name="provider" value="email" type="submit">Email</button> : ""}
				</p>
			</form>
			{input.turnstileSiteKey ? (
				<>
					<script src="/turnstile.js"></script>
					<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
				</>
			) : ""}
		</div>
	).toString();
}
