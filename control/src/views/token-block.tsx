/**
 * The token is the input's value, with no extra text around it.
 * A copy of that value has no surrounding whitespace. `<pre>` adds a trailing newline.
 */
export function TokenBlock(props: { token: string; lead: string }) {
	const value = props.token.trim();
	if (!value) return null;
	return (
		<div class="token" role="status">
			<p>{props.lead}</p>
			<p class="token-actions">
				<input class="token-value" type="text" readonly value={value} autocomplete="off" aria-label="Owner token" />
				<button class="action copy-token" type="button" hidden>Copy</button>
			</p>
			<script src="/owner-token.js"></script>
		</div>
	);
}
