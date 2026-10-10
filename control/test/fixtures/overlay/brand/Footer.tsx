export function Footer(props: { name: string; links: { href: string; label: string }[] }) {
	return (
		<footer>
			<p>{props.name}</p>
			<nav>
				{props.links.map((link) => <a href={link.href}>{link.label}</a>)}
			</nav>
		</footer>
	);
}
