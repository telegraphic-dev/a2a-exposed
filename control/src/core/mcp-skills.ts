// The published library owns the portable edition; hosted consumers never copy skills.
import catalog from "../../../worker/src/mcp-portable-skills-catalog.json" with { type: "json" };
import { servePortableSkills, SKILLS_CAPABILITIES, SKILLS_METHODS, type SkillCatalog } from "../../../worker/src/mcp-skills.ts";
export const portableMcpSkills = {
 capabilities: SKILLS_CAPABILITIES,
 methods: SKILLS_METHODS,
 serve(request: Request, message: unknown, info: { name: string; version: string; title?: string; websiteUrl?: string }) {
  return servePortableSkills(catalog as SkillCatalog, request, message, info);
 },
};
