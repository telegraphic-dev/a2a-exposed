import { createMcpHandler, McpServer, ProtocolError, INVALID_PARAMS, type Implementation } from "@modelcontextprotocol/server";
import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { SKILLS_EXTENSION_ID, type Skill } from "@modelcontextprotocol/core/ext/skills";

/** Build-time catalog checked against the official SDK wire schema. No filesystem or network access on the Worker request path. */
export type SkillCatalog = { skills: Skill[]; resources: Record<string, string> };
export const SKILLS_CAPABILITIES = { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } };
export const SKILLS_METHODS = ["skills/list", "skills/get", "resources/list", "resources/read", "resources/templates/list"];

/** Only exact published identifiers may reach the SDK's URL-based resource routing. */
export function knownSkillResource(catalog: SkillCatalog, uri: unknown): uri is string {
	return typeof uri === "string" && Object.hasOwn(catalog.resources, uri) &&
		catalog.skills.some((skill) => Array.isArray(skill.resources) && skill.resources.some((resource) => resource.uri === uri));
}

export function resourceContent(catalog: SkillCatalog, uri: string): { uri: string; mimeType: string } & ({ text: string; blob?: never } | { blob: string; text?: never }) {
	const blob = catalog.resources[uri];
	if (uri.endsWith(".md")) {
		const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
		let text: string | undefined;
		try {
			// ignoreBOM=true preserves a leading BOM as text; fatal rejects invalid UTF-8.
			const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			const encoded = new TextEncoder().encode(decoded);
			if (encoded.length === bytes.length && encoded.every((byte, i) => byte === bytes[i])) text = decoded;
		} catch { /* Non-UTF-8 content remains binary with its original bytes. */ }
		if (text !== undefined) return { uri, mimeType: "text/markdown", text };
	}
	return { uri, mimeType: "application/octet-stream", blob };
}

/** Portable MCP edition uses the official strict Skills extension, not the canonical compatibility adapter. */
export async function servePortableSkills(catalog: SkillCatalog, request: Request, message: unknown, info: Implementation): Promise<Response> {
	const params = message && typeof message === "object" && "params" in message ? message.params : undefined;
	const requestedUri = params && typeof params === "object" && "uri" in params ? params.uri : undefined;
	const extension = new SkillsExtension({ strict: true, baseUri: "skill://portable", cacheHint: { ttlMs: 300_000, cacheScope: "public" }, source: {
		async list({ cursor }) {
			if (cursor !== undefined) throw new ProtocolError(INVALID_PARAMS, "Unknown skills cursor");
			return { skills: catalog.skills };
		},
		async get(uri) { return catalog.skills.find((skill) => skill.uri === uri); },
		async read(uri) {
			if (uri !== requestedUri || !knownSkillResource(catalog, uri)) return undefined;
			const content = resourceContent(catalog, uri);
			return content.text !== undefined ? { text: content.text, mimeType: content.mimeType } : {
				bytes: Uint8Array.from(atob(content.blob!), (char) => char.charCodeAt(0)), mimeType: content.mimeType,
			};
		},
		async listResources() { return catalog.skills.map((skill) => ({ uri: skill.uri, name: skill.frontmatter.name, description: skill.frontmatter.description, mimeType: "text/markdown" })); },
	} });
	const handler = createMcpHandler(() => {
		const mcp = new McpServer(info);
		extension.attach(mcp);
		return mcp;
	}, { legacy: "reject", responseMode: "json", maxRequestBodySize: 1_048_576 });
	return handler.fetch(request, { parsedBody: message });
}
