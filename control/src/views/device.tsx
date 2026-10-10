export function renderDevice(input: {
	userCode: string;
	signedIn: boolean;
	email?: string;
	signInHtml?: string;
	done?: string;
	error?: string;
}): string {
	const done = input.done === "approved"
		? "Approved. Return to the terminal."
		: input.done === "denied"
			? "Denied. The terminal will stop waiting."
			: "";
	const error = input.error === "code"
		? "That code is not valid."
		: input.error === "auth"
			? "Sign in, then approve the code."
			: "";
	return (
		<div>
			<h1>Approve this terminal</h1>
			{done ? <p>{done}</p> : ""}
			{error ? <p>{error}</p> : ""}
			{input.userCode ? <p>Code <strong>{input.userCode}</strong></p> : (
				<form method="get" action="/app/device">
					<p>
						<label>
							Code
							<input name="user_code" autocomplete="off" />
						</label>
					</p>
					<p><button type="submit">Continue</button></p>
				</form>
			)}
			{input.userCode && input.signedIn ? (
				<form method="post" action="/app/device">
					<input type="hidden" name="user_code" value={input.userCode} />
					<p>{input.email ? `Signed in as ${input.email}.` : "Signed in."}</p>
					<p>
						<button name="action" value="approve" type="submit">Approve</button>
						<button name="action" value="deny" type="submit">Deny</button>
					</p>
				</form>
			) : ""}
			{input.userCode && !input.signedIn && input.signInHtml
				? <div dangerouslySetInnerHTML={{ __html: input.signInHtml }} />
				: ""}
		</div>
	).toString();
}
