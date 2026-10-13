const CONNECTION_PHRASE = { webhook: "webhook wake", proxy: "proxy", polling: "polling" } as const;

/** Agent page shell. The sections sit in reading order, with no heading above Overview. */
export function renderAgentPage(input: {
	overviewHtml: string;
	peersHtml: string;
	wakeHtml: string;
	recordsHtml: string;
	advancedHtml: string;
	dangerHtml: string;
	feedback?: { connection: keyof typeof CONNECTION_PHRASE };
}): string {
	const feedback = input.feedback;
	const href = feedback ? `/app/feedback?deployment=hosted&connection=${feedback.connection}` : "";
	return (
		<div class="agent-page">
			<p><a href="/app">Your agents</a></p>
			<div dangerouslySetInnerHTML={{ __html: input.overviewHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.peersHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.wakeHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.recordsHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.advancedHtml }} />
			<div dangerouslySetInnerHTML={{ __html: input.dangerHtml }} />
			{feedback ? (
				<p>Deployment: hosted. Connection: {CONNECTION_PHRASE[feedback.connection]}. <a href={href}>Send feedback</a></p>
			) : ""}
		</div>
	).toString();
}
