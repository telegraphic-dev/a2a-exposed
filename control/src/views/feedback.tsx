const ERRORS: Record<string, string> = {
	invalid: "Write a message, at most 4000 characters.",
	turnstile: "Wait for the check to finish, then try again.",
	rate_limit: "Too many reports from here. Try again in an hour.",
	timeout: "That took too long. Try again.",
	unavailable: "Feedback could not be filed. Try again.",
	origin: "That request came from another site.",
};

export function renderFeedback(input: {
	turnstileSiteKey?: string;
	error?: string;
	sent?: boolean;
	issueUrl?: string;
}): string {
	const error = input.error ? ERRORS[input.error] ?? ERRORS.unavailable : "";
	return (
		<div>
			<p>A bug, an idea, or something that got in the way. Don't include tokens, passwords, or keys.</p>
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{input.sent ? <p role="status">Sent.{input.issueUrl ? <> <a href={input.issueUrl}>Issue</a></> : ""}</p> : ""}
			<form class="feedback" method="post" action="/app/feedback">
				<input type="hidden" name="source" value="web" />
				<p>
					<label>
						What happened
						<textarea name="message" required maxlength={4000} />
					</label>
				</p>
				<p>
					<label>
						Kind
						<select name="kind">
							<option value="bug">Bug</option>
							<option value="idea">Idea</option>
							<option value="other" selected>Other</option>
						</select>
					</label>
				</p>
				<p>
					<label>
						Contact <span>Optional. An email or a handle.</span>
						<input name="contact" maxlength={200} autocomplete="off" />
					</label>
				</p>
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
				<p><button class="action" type="submit" disabled={input.turnstileSiteKey ? true : undefined}>Send</button></p>
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
