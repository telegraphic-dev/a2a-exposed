/** Agent page shell. The wake section is the first one; later sections are added beside it. */
export function renderAgentPage(input: { publicUrl: string; wakeHtml: string }): string {
	return (
		<div>
			<p><a href="/app">Your agents</a></p>
			{input.publicUrl ? <p><a href={input.publicUrl}>{input.publicUrl}</a></p> : ""}
			<div dangerouslySetInnerHTML={{ __html: input.wakeHtml }} />
		</div>
	).toString();
}
