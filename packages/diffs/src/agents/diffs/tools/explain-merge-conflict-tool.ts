import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentLoop } from "../diffs-agent-loop";

const explainMergeConflictInputSchema = z.object({
    slug: z.string().describe("The exact slug of the pre-classified merge conflict test"),
    reasoning: z
        .string()
        .describe(
            "Explanation of how the plans on the different sides of the merge diverge and what needs to be reconciled during resolution.",
        ),
});

export type ExplainMergeConflictInput = z.infer<typeof explainMergeConflictInputSchema>;

interface ExplainMergeConflictOutput {
    slug: string;
}

class UnknownConflictSlugError extends FixableToolError {
    constructor(public readonly slug: string) {
        super(
            `Slug "${slug}" is not a pre-classified merge conflict. Only use slugs from the "Pre-classified merge conflicts" section.`,
        );
    }
}

class MissingConflictEntryError extends FixableToolError {
    constructor(public readonly slug: string) {
        super(`No pre-classified merge-conflict entry found for slug "${slug}".`);
    }
}

/**
 * Action tool: attach reasoning to a pre-classified merge-conflict entry that
 * was seeded onto the loop's affected-tests list before the agent ran. Only
 * fills in the `reasoning` field - the entry is already recorded.
 */
export class ExplainMergeConflictTool extends AgentTool<
    ExplainMergeConflictInput,
    ExplainMergeConflictOutput,
    DiffsAgentLoop
> {
    constructor() {
        super({
            name: "explain_merge_conflict",
            description:
                "Attach reasoning to a pre-classified merge-conflict test. " +
                "The test is already marked as affected with `affectedReason: merge_conflict` - " +
                "this tool only fills in the reasoning that explains how the plans diverge. " +
                "Only use slugs explicitly listed in the 'Pre-classified merge conflicts' section of the prompt.",
            inputSchema: explainMergeConflictInputSchema,
        });
    }

    protected async execute(
        { slug, reasoning }: ExplainMergeConflictInput,
        loop: DiffsAgentLoop,
    ): Promise<ExplainMergeConflictOutput> {
        if (!loop.validConflictSlugs.has(slug)) throw new UnknownConflictSlugError(slug);
        const entry = loop.affectedTests.find((t) => t.slug === slug && t.affectedReason === "merge_conflict");
        if (entry == null) throw new MissingConflictEntryError(slug);
        entry.reasoning = reasoning;
        return { slug };
    }
}
