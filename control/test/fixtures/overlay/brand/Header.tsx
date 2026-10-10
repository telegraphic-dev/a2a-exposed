export function Header(props: { name: string }) {
	return (
		<header data-overlay="fixture">
			<a href="/">{props.name}</a>
		</header>
	);
}
