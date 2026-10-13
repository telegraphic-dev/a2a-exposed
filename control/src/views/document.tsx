import { raw } from "hono/html";
import { brandConfig } from "@brand/brand.config.ts";
import { Footer } from "@brand/Footer.tsx";
import { Header } from "@brand/Header.tsx";
import { SignInAside } from "@brand/SignInAside.tsx";
import { PROVIDER_ORIGINS } from "../auth/sign-in.ts";

const KNOWN_FORM_ORIGINS = new Set<string>(Object.values(PROVIDER_ORIGINS));
const KNOWN_IMG_ORIGINS = new Set([
	"https://avatars.githubusercontent.com",
	"https://lh3.googleusercontent.com",
]);

export function securityHeaders(options: { turnstile?: boolean; formAction?: readonly string[]; imgSrc?: readonly string[]; scriptSelf?: boolean } = {}): Record<string, string> {
	const host = options.turnstile ? "https://challenges.cloudflare.com" : "'none'";
	const script = options.turnstile ? "'self' https://challenges.cloudflare.com" : options.scriptSelf ? "'self'" : "'none'";
	const formAction = ["'self'", ...(options.formAction ?? []).filter((origin) => KNOWN_FORM_ORIGINS.has(origin))].join(" ");
	const imgSrc = ["'self'", ...(options.imgSrc ?? []).filter((origin) => KNOWN_IMG_ORIGINS.has(origin))].join(" ");
	const csp = [
		"default-src 'none'",
		"style-src 'self'",
		imgSrc === "'self'" ? "img-src 'self'" : `img-src ${imgSrc}`,
		`script-src ${script}`,
		`frame-src ${host}`,
		`connect-src ${host}`,
		"base-uri 'none'",
		`form-action ${formAction}`,
		"frame-ancestors 'none'",
	].join("; ");
	return {
		"content-security-policy": csp,
		// `no-referrer` makes a browser send `Origin: null` on a same-origin form POST.
		"referrer-policy": "same-origin",
		"x-content-type-options": "nosniff",
	};
}

export interface AppAccount {
	name: string;
	email: string;
	image?: string;
}

/** Signed-in chrome. Marketing pages keep the brand header. */
function AppHeader(props: { brand: string; account: AppAccount }) {
	const image = props.account.image ?? "";
	return (
		<header class="app-header">
			<a class="brand" href="/">
				<img src="/logo.svg" alt="" width={32} height={32} />
				<span>{props.brand}</span>
			</a>
			<details class="nav-menu">
				<summary class="nav-toggle">Menu</summary>
				<nav class="app-nav">
					<a href="/docs">Docs</a>
					<a href="/pricing">Pricing</a>
					<a href="/app/feedback">Feedback</a>
				</nav>
			</details>
			<details class="account-menu">
				<summary>
					{image ? <img class="photo" src={image} alt="" /> : <span class="photo" />}
					<span class="menu-label">Account</span>
				</summary>
				<div>
					{props.account.name ? <p><strong>{props.account.name}</strong></p> : ""}
					{props.account.email ? <p>{props.account.email}</p> : ""}
					<p><a href="/app/settings">Settings</a></p>
					<form method="post" action="/app/sign-out">
						<p><button type="submit">Sign out</button></p>
					</form>
				</div>
			</details>
		</header>
	);
}

export function renderDocument(input: {
	env?: { BRAND_NAME?: string };
	title?: string;
	description?: string;
	bodyHtml?: string;
	extraHtml?: string;
	robots: string;
	aside?: boolean;
	hideHeading?: boolean;
	account?: AppAccount;
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
				{input.account ? <AppHeader brand={brand.name} account={input.account} /> : <Header name={brand.name} />}
				<main>
					{input.hideHeading ? "" : <h1>{heading}</h1>}
					{input.aside ? <SignInAside /> : ""}
					{input.bodyHtml ? raw(input.bodyHtml) : ""}
					{input.extraHtml ? raw(input.extraHtml) : ""}
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

export function renderApp(
	env?: { BRAND_NAME?: string },
	bodyHtml?: string,
	title?: string,
	extraHtml?: string,
	options?: { hideHeading?: boolean; account?: AppAccount },
): string {
	return renderDocument({
		env,
		title,
		robots: "noindex",
		aside: !bodyHtml,
		bodyHtml,
		extraHtml,
		hideHeading: options?.hideHeading,
		account: options?.account,
	});
}
