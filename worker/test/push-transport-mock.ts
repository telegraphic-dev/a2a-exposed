import type { TestContext } from "node:test";
import { DOH_URL, wakeNet, type CheckedDeliver } from "../src/wake-target.ts";

/** Preserve the test's HTTP handler while exercising the public-DNS gate before push delivery. */
export function mockPushTransport(t: TestContext, deliver?: CheckedDeliver) {
	const originalFetch = globalThis.fetch;
	const originalDeliver = wakeNet.deliver;
	const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.origin === new URL(DOH_URL).origin) return Response.json({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] });
		if (deliver) throw new Error("unexpected unpinned push fetch");
		return originalFetch(input, init);
	}) as typeof fetch;
	globalThis.fetch = wrappedFetch;
	wakeNet.deliver = deliver ?? ((url, init) => originalFetch(url, init));
	t.after(() => { if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch; wakeNet.deliver = originalDeliver; });
}
