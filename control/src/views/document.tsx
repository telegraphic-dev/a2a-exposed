import { raw } from "hono/html";
import { brandConfig } from "@brand/brand.config.ts";
import { Footer } from "@brand/Footer.tsx";
import { Header } from "@brand/Header.tsx";
import { SignInAside } from "@brand/SignInAside.tsx";

export function securityHeaders(options: { turnstile?: boolean } = {}): Record<string, string> {
	const host = options.turnstile ? "https://challenges.cloudflare.com" : "'none'";
	const script = options.turnstile ? "'self' https://challenges.cloudflare.com" : "'none'";
	const csp = [
		"default-src 'none'",
		"style-src 'self'",
		"img-src 'self'",
		`script-src ${script}`,
		`frame-src ${host}`,
		`connect-src ${host}`,
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
	return {
		"content-security-policy": csp,
		// `no-referrer` makes a browser send `Origin: null` on a same-origin form POST.
		"referrer-policy": "same-origin",
		"x-content-type-options": "nosniff",
	};
}

export function renderDocument(input: {
	env?: { BRAND_NAME?: string };
	title?: string;
	description?: string;
	bodyHtml?: string;
	robots: string;
	aside?: boolean;
}): string {
	const brand = brandConfig(input.env ?? {});
	const pageTitle = input.title?.trim()
		? `${input.title.trim()} · ${brand.name}`
		: `${brand.name}: sign in / create an agent`;
	const heading = input.title?.trim() || `${brand.name}: sign in / create an agent`;
	const description = input.description?.trim() ?? "";
	return "<!doctype html>" + (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{pageTitle}</title>
				{description ? <meta name="description" content={description} /> : ""}
				<meta name="robots" content={input.robots} />
				<link rel="stylesheet" href="/tokens.css" />
				<link rel="stylesheet" href="/app.css" />
				<link rel="icon" href="/logo.svg" type="image/svg+xml" />
			</head>
			<body>
				<Header name={brand.name} />
				<main>
					<h1>{heading}</h1>
					{input.aside ? <SignInAside /> : ""}
					{input.bodyHtml ? raw(input.bodyHtml) : ""}
				</main>
				<Footer name={brand.name} links={brand.footerLinks} />
			</body>
		</html>
	);
}

export function renderHome(env?: { BRAND_NAME?: string }): string {
	return renderDocument({
		env,
		robots: "index,follow",
		aside: true,
	});
}

export function renderApp(env?: { BRAND_NAME?: string }, bodyHtml?: string): string {
	return renderDocument({
		env,
		robots: "noindex",
		aside: !bodyHtml,
		bodyHtml,
	});
}
