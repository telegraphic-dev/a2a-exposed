// Local workerd closes an HTTP/1.1 keep-alive connection whenever the Worker
// answers without reading the request body (every 401/503/413 rejection on
// the relay ingress), and it does so without sending `Connection: close`.
// Node's fetch returns that socket to its pool on the response and can write
// the next request to it before the FIN arrives; that request then fails with
// "TypeError: fetch failed" (ECONNRESET / other side closed). Undici never
// retries a POST, so loaded CI runners turn this race into a flaky test.
//
// Sending `Connection: close` makes undici retire the socket after each
// response, so no request is ever written to a connection workerd already
// closed. It changes no assertion. (Miniflare's dispatchFetch resets this
// header, so tests that need it fetch the loopback URL directly.)
function closeConnection(init?: RequestInit, input?: RequestInfo | URL): RequestInit {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	headers.set("connection", "close");
	return { ...init, headers };
}

export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, closeConnection(init, input));
