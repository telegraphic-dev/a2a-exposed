// Canonical nested-metadata compatibility experiment; never imported by product runtime.
import { createMcpHandler, McpServer, ResourceTemplate, ProtocolError, INVALID_PARAMS, type Implementation } from "@modelcontextprotocol/server";
import { ListSkillsRequestParamsSchema, GetSkillRequestParamsSchema, ListSkillsResultSchema, GetSkillResultSchema } from "@modelcontextprotocol/core/ext/skills";
import { SKILLS_CAPABILITIES, knownSkillResource, resourceContent, type SkillCatalog } from "../src/mcp-skills.ts";

/** Existing native MCP authorization, limits and origin checks run before this adapter. */
export async function serveSkills(catalog: SkillCatalog, request: Request, message: unknown, info: Implementation): Promise<Response> {
	// The SDK resource callback receives a parsed URL, which can normalize dot segments.
	// Bind reads to the original, exact identifier before handing routing to the SDK.
	const params = message && typeof message === "object" && "params" in message ? message.params : undefined;
	const requestedUri = params && typeof params === "object" && "uri" in params ? params.uri : undefined;
	const handler = createMcpHandler(() => {
		const mcp = new McpServer(info);
		const server = mcp.server;
		const cache = { ttlMs: 300_000, cacheScope: "public" as const };
		server.registerCapabilities(SKILLS_CAPABILITIES);
		server.setRequestHandler("skills/list", { params: ListSkillsRequestParamsSchema, result: ListSkillsResultSchema }, async (params) => {
			if (params.cursor !== undefined) throw new ProtocolError(INVALID_PARAMS, "Unknown skills cursor");
			return { skills: catalog.skills, ...cache };
		});
		server.setRequestHandler("skills/get", { params: GetSkillRequestParamsSchema, result: GetSkillResultSchema }, async ({ uri }) => {
			const skill = catalog.skills.find((entry) => entry.uri === uri);
			if (!skill) throw new ProtocolError(INVALID_PARAMS, "Unknown skill URI");
			return { skill, ...cache };
		});
		mcp.registerResource("canonical-skills", new ResourceTemplate("skill://{+path}", { list: async () => ({ resources: catalog.skills.map((skill) => ({
			uri: skill.uri, name: skill.frontmatter.name, description: skill.frontmatter.description, mimeType: "text/markdown",
		})) }) }), {}, async (uri) => {
			if (uri.href !== requestedUri || !knownSkillResource(catalog, requestedUri)) throw new ProtocolError(INVALID_PARAMS, "Unknown skill resource URI");
			return { contents: [resourceContent(catalog, requestedUri)] };
		});
		return mcp;
	}, { legacy: "reject", responseMode: "json", maxRequestBodySize: 1_048_576 });
	return handler.fetch(request, { parsedBody: message });
}
