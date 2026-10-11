/** Agent page shell. Overview, pairing, records, and wake sit on the same page. */
export function renderAgentPage(input: { overviewHtml: string; peersHtml: string; recordsHtml: string; wakeHtml: string; reauthHref?: string }): string {
	const reauth = input.reauthHref ?? "";
	return (
		<div>
			<p><a href="/app">Your agents</a></p>
			{reauth ? (
				<p class="alert" role="status">Your sign-in is older than 10 minutes. <a href={reauth}>Sign in again</a> before you approve, deny, revoke, rotate, or delete.</p>
			) : ""}
			<div dangerouslySetInnerHTML={{ __html: input.overviewHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.peersHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.recordsHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.wakeHtml }} />
		</div>
	).toString();
}
