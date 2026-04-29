import { tool } from "ai";
import { z } from "zod";
import type { AffectedTest } from "./mark-affected-test-tool";

const explainSchema = z.object({
    slug: z.string().describe("The exact slug of the pre-classified merge conflict test"),
    reasoning: z
        .string()
        .describe(
            "Explanation of how the plans on the different sides of the merge diverge and what needs to be reconciled during resolution.",
        ),
});

/**
 * Attaches reasoning to a merge-conflict entry that was pre-created before the
 * agent ran. The entry already carries `affectedReason: "merge_conflict"`; the
 * agent only fills in the `reasoning` field. This avoids the class of bugs
 * where the agent forgets, duplicates, or mislabels a conflict slug.
 */
export function buildExplainMergeConflictTool(
    collector: { affectedTests: AffectedTest[] },
    validConflictSlugs: Set<string>,
) {
    return tool({
        description:
            "Attach reasoning to a pre-classified merge-conflict test. " +
            "The test is already marked as affected with `affectedReason: merge_conflict` - " +
            "this tool only fills in the reasoning that explains how the plans diverge. " +
            "Only use slugs explicitly listed in the 'Pre-classified merge conflicts' section of the prompt.",
        inputSchema: explainSchema,
        execute: ({ slug, reasoning }) => {
            if (!validConflictSlugs.has(slug)) {
                return {
                    success: false,
                    error: `Slug "${slug}" is not a pre-classified merge conflict. Only use slugs from the "Pre-classified merge conflicts" section.`,
                };
            }
            const entry = collector.affectedTests.find((t) => t.slug === slug && t.affectedReason === "merge_conflict");
            if (entry == null) {
                return {
                    success: false,
                    error: `No pre-classified merge-conflict entry found for slug "${slug}".`,
                };
            }
            entry.reasoning = reasoning;
            return { success: true, slug };
        },
    });
}
