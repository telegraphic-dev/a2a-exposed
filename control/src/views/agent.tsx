/** Agent page shell. Overview, pairing, records, and wake sit on the same page. */
export function renderAgentPage(input: { overviewHtml: string; peersHtml: string; recordsHtml: string; wakeHtml: string }): string {
	return (
		<div>
			<p><a href="/app">Your agents</a></p>
			<div dangerouslySetInnerHTML={{ __html: input.overviewHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.peersHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.recordsHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.wakeHtml }} />
		</div>
	).toString();
}
