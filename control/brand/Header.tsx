export function Header(props: { name: string }) {
	return (
		<header>
			<a href="/">
				<img src="/logo.svg" alt="" width={32} height={32} />
				<span>{props.name}</span>
			</a>
		</header>
	);
}
