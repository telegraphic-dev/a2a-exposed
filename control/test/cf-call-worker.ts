import { cfCall } from "../src/provision/cloudflare-api.ts";

export default {
	async fetch(request: Request): Promise<Response> {
		const token = new URL(request.url).searchParams.get("token") ?? "";
		const result = await cfCall({
			fetchImpl: fetch,
			token,
			method: "GET",
			path: "/accounts?per_page=50",
			fetchMs: 5_000,
		});
		if (result.ok) return Response.json({ ok: true, status: result.status });
		return Response.json({ ok: false, status: result.status, thrown: result.thrown ?? null });
	},
};
