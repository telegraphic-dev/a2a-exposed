export function brandConfig(_env?: { BRAND_NAME?: string }) {
	return {
		name: "Fixture",
		supportEmail: "",
		footerLinks: [{ href: "/legal", label: "Legal" }],
		legal: {},
	};
}
