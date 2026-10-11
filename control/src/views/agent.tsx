/** Agent page shell. Overview and wake are the first sections; later sections are added beside them. */
export function renderAgentPage(input: { overviewHtml: string; wakeHtml: string }): string {
	return (
		<div>
			<p><a href="/app">Your agents</a></p>
			<div dangerouslySetInnerHTML={{ __html: input.overviewHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.wakeHtml }} />
		</div>
	).toString();
}
