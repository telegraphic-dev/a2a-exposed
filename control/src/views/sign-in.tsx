const PROVIDERS = [
	["github", "GitHub"],
	["google", "Google"],
	["cloudflare", "Cloudflare"],
] as const;

const ERRORS: Record<string, string> = {
	invite: "That invite code is not valid.",
	INVITE_REQUIRED: "That invite code is not valid.",
	turnstile: "Wait for the check to finish, then try again.",
	"invalid-input-response": "The check failed. Try again.",
	"missing-input-response": "The check failed. Try again.",
	"bad-request": "The check failed. Try again.",
	"timeout-or-duplicate": "The check expired. Try again.",
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
				<p>
					{buttons.map(([id, label]) => input.turnstileSiteKey
						? <button name="provider" value={id} type="submit" disabled>{label}</button>
						: <button name="provider" value={id} type="submit">{label}</button>)}
					{input.magicLink ? input.turnstileSiteKey
						? <button name="provider" value="email" type="submit" disabled>Email</button>
						: <button name="provider" value="email" type="submit">Email</button> : ""}
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
