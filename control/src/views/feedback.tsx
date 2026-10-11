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
			<p>Reproduction steps help most.</p>
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
						Steps <span>Optional. The exact commands, and what you saw.</span>
						<textarea name="steps" maxlength={4000} />
					</label>
				</p>
				<p>
					<label>
						Expected <span>Optional.</span>
						<textarea class="short" name="expected" maxlength={2000} />
					</label>
				</p>
				<p>
					<label>
						Actual <span>Optional. Error output belongs here, without tokens or keys.</span>
						<textarea class="short" name="actual" maxlength={2000} />
					</label>
				</p>
				<p>
					<label>
						Agent <span>Optional. Claude Code, Grok Bot, n8n, or custom.</span>
						<input name="agent" maxlength={80} autocomplete="off" />
					</label>
				</p>
				<p>
					<label>
						Environment <span>Optional.</span>
						<select name="environment">
							<option value="">Optional</option>
							<option value="local laptop">Local laptop</option>
							<option value="cloud VM/VPS">Cloud VM/VPS</option>
							<option value="CI">CI</option>
							<option value="cloud agent sandbox">Cloud agent sandbox</option>
							<option value="Cloudflare Worker">Cloudflare Worker</option>
						</select>
					</label>
				</p>
				<p>
					<label>
						OS <span>Optional.</span>
						<input name="os" maxlength={80} autocomplete="off" />
					</label>
				</p>
				<p>
					<label>
						Node <span>Optional. The Node.js version.</span>
						<input name="node" maxlength={32} autocomplete="off" />
					</label>
				</p>
				<p>
					<label>
						Mode <span>Optional.</span>
						<select name="mode">
							<option value="">Optional</option>
							<option value="hosted">Hosted</option>
							<option value="self-host">Self-host</option>
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
