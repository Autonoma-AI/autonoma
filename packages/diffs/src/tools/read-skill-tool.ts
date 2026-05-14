import { tool } from "ai";
import { z } from "zod";
import type { ExistingSkillInfo } from "../diffs-agent";

const readSkillSchema = z.object({
    slug: z.string().describe("The slug of the skill to read."),
});

export function buildReadSkillTool(skills: ExistingSkillInfo[]) {
    const skillsBySlug = new Map(skills.map((s) => [s.slug, s]));

    return tool({
        description: "Read the full content of a specific skill by its slug.",
        inputSchema: readSkillSchema,
        execute: async ({ slug }) => {
            const skill = skillsBySlug.get(slug);
            if (skill == null) {
                return { error: `Skill "${slug}" not found.` };
            }
            return { slug, name: skill.name, description: skill.description, content: skill.content };
        },
    });
}
