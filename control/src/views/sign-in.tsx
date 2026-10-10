const PROVIDERS = [
	["github", "GitHub"],
	["google", "Google"],
	["cloudflare", "Cloudflare"],
] as const;

const ERRORS: Record<string, string> = {
	invite: "That invite code is not valid.",
	turnstile: "The check failed. Try again.",
	email: "Enter an email address.",
	auth: "Sign-in did not complete.",
	unavailable: "Login is not available.",
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
				{input.turnstileSiteKey ? <div class="cf-turnstile" data-sitekey={input.turnstileSiteKey}></div> : ""}
				<p>
					{buttons.map(([id, label]) => <button name="provider" value={id} type="submit">{label}</button>)}
					{input.magicLink ? <button name="provider" value="email" type="submit">Email</button> : ""}
				</p>
			</form>
			{input.turnstileSiteKey ? <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script> : ""}
		</div>
	).toString();
}
