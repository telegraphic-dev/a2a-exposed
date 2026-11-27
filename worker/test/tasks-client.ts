// The official MCP client with the official Tasks extension, as a host integrates them:
// https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html
// The SDK Client owns the session and HTTP transport; the extension owns Task framing, schemas and
// lifecycle (including the terminal resultCodec). This host only matches raw request ids.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTaskSessionFromClient, toolDeclarationFromMcpTool } from "@modelcontextprotocol/ext-tasks/client";

type Pending = (error: unknown, response?: unknown) => void;

class CoordinatedTransport {
	onmessage?: (message: any, extra?: any) => void;
	onerror?: (error: Error) => void;
	onclose?: () => void;
	private pending = new Map<string, Pending>();
	private next = 0;
	private inner: StreamableHTTPClientTransport;
	constructor(inner: StreamableHTTPClientTransport) {
		this.inner = inner;
		inner.onmessage = (message: any, extra?: any) => {
			if (typeof message.id === "string" && message.id.startsWith("raw-task:")) {
				this.pending.get(message.id)?.(null, "error" in message ? { kind: "error", error: message.error } : { kind: "result", result: message.result });
				return;
			}
			this.onmessage?.(message, extra);
		};
		inner.onerror = (error: Error) => { this.fail(error); this.onerror?.(error); };
		inner.onclose = () => { this.fail(new Error("closed")); this.onclose?.(); };
	}
	get sessionId() { return this.inner.sessionId; }
	setProtocolVersion(version: string) { this.inner.setProtocolVersion(version); }
	start() { return this.inner.start(); }
	send(message: any, options?: any) { return this.inner.send(message, options); }
	async close() { this.fail(new Error("closed")); await this.inner.close(); }
	private fail(error: unknown) { for (const done of [...this.pending.values()]) done(error); }
	dispatch = (request: any, options: any = {}) => new Promise((resolve, reject) => {
		const id = `raw-task:${++this.next}`;
		const done: Pending = (error, response) => {
			if (!this.pending.delete(id)) return;
			error ? reject(error) : resolve(response);
		};
		this.pending.set(id, done);
		this.inner.send({ ...request, jsonrpc: "2.0", id }, options.context?.headers ? { headers: options.context.headers } : undefined).catch(done);
	});
}

/** A Tasks-enabled session over `fetchImpl`, authenticated with `token`. */
export async function officialTasksClient(url: string, token: string, fetchImpl: (request: Request) => Promise<Response>) {
	const info = { name: "official-tasks-client", version: "1.0.0" };
	const capabilities = { extensions: { "io.modelcontextprotocol/tasks": {} } };
	const client = new Client(info, { capabilities, versionNegotiation: { mode: { pin: "2026-07-28" } } } as any);
	const transport = new CoordinatedTransport(new StreamableHTTPClientTransport(new URL(url), {
		fetch: (input: any, init?: any) => {
			const request = new Request(input, init);
			request.headers.set("authorization", `Bearer ${token}`);
			return fetchImpl(request);
		},
	}));
	await client.connect(transport as any);
	const { tools } = await client.listTools();
	const declarations = new Map(tools.map((tool) => [tool.name, toolDeclarationFromMcpTool(tool as any)]));
	const session = createTaskSessionFromClient(client as any, {
		endpointId: url,
		rawDispatch: transport.dispatch as any,
		v2RequestFraming: { protocolVersion: "2026-07-28", clientInfo: info, clientCapabilities: capabilities },
		tools: { currentTool: (name: string) => declarations.get(name) },
	} as any);
	return {
		start: (tool: string, taskId: string) => session.callTool(tool, { taskId }, { task: { preference: "require" } } as any) as Promise<any>,
		snapshot: (taskId: string) => session.task(taskId).snapshot() as Promise<any>,
		result: (taskId: string) => session.task(taskId).result() as Promise<any>,
		cancel: (taskId: string) => session.task(taskId).cancel(),
		async close() { try { await session.close(); } finally { await client.close(); } },
	};
}
