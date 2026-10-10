function safeHref(href: string): string | null {
	if (href.startsWith("/") && !href.startsWith("//")) return href;
	try {
		const url = new URL(href);
		if (url.protocol === "https:") return url.href;
	} catch {
		return null;
	}
	return null;
}

export function Footer(props: { name: string; links: { href: string; label: string }[] }) {
	const links = props.links.flatMap((link) => {
		const href = safeHref(link.href);
		return href ? [<a href={href}>{link.label}</a>] : [];
	});
	return (
		<footer>
			<p>{props.name}</p>
			{links.length ? <nav>{links}</nav> : ""}
		</footer>
	);
}
