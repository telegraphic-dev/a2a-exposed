import http from 'node:http';
import https from 'node:https';

// Keep native WebSocket validation and framing, but make exactly one upgrade
// request. Fetch's HTTP 401 authentication retry can otherwise repeat the same
// credential-bearing handshake before WebSocket emits an error on Node 24.
// This implements the documented Undici Dispatcher handshake callbacks; it is
// scoped to relay sockets and never changes the process-wide fetch dispatcher.
export const relayDispatcher = {
	dispatch(options, handler) {
		let request, socket, settled = false, aborted = false;
		// Node 26 uses Undici's controller callbacks; Node 22/24 use legacy callbacks.
		const modern = typeof handler.onRequestStart === 'function';
		const controller = {
			abort: () => { aborted = true; request?.destroy(); socket?.destroy(); fail(); },
			get aborted() { return aborted; }, rawHeaders: [],
		};
		const fail = () => {
			if (settled) return;
			settled = true;
			request?.destroy(); socket?.destroy();
			if (modern) handler.onResponseError(controller, new Error('relay upgrade failed'));
			else handler.onError(new Error('relay upgrade failed'));
		};
		try {
			const origin = new URL(options.origin);
			if (!['http:', 'https:'].includes(origin.protocol) || options.method !== 'GET' || options.upgrade !== 'websocket' || options.body) throw new Error();
			request = (origin.protocol === 'https:' ? https : http).request(origin, {
				method: 'GET', path: options.path, agent: false,
				headers: { ...options.headers, connection: 'Upgrade', upgrade: 'websocket' },
			});
			request.on('error', fail);
			// Reject all non-upgrades here, without exposing an HTTP response to
			// Fetch's authentication/redirect machinery. Never consume a body.
			request.on('response', response => { response.destroy(); fail(); });
			request.on('upgrade', (response, upgraded, head) => {
				socket = upgraded;
				if (settled || response.statusCode !== 101) { upgraded.destroy(); fail(); return; }
				if (head.length) upgraded.unshift(head);
				try {
					if (modern) {
						controller.rawHeaders = response.rawHeaders.map(value => Buffer.from(value, 'latin1'));
						handler.onRequestUpgrade(controller, 101, response.headers, upgraded);
					} else handler.onUpgrade(101, response.rawHeaders.map(value => Buffer.from(value, 'latin1')), upgraded);
					settled = true;
				}
				catch { fail(); }
			});
			if (modern) handler.onRequestStart(controller, {});
			else handler.onConnect(() => { request.destroy(); socket?.destroy(); fail(); });
			if (!settled) request.end();
		} catch { fail(); }
		return true;
	},
};
