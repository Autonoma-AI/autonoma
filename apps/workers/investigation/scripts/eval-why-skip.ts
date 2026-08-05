/**
 * Diagnostic (NOT shipped): why does the selector propose / skip a new test? Runs the REAL selector prompt +
 * tools against one twin snapshot, but with a DEBUG schema that forces the model to state its propose/skip
 * decision and reasoning. Read-only (clone + reads), no writes.
 *
 *   tsx --env-file=<dir>/.worker.env scripts/eval-why-skip.ts <snapshotId>
 */
import { db } from "@autonoma/db";
import {
    AffectedTestSelection,
    LocalCodebaseReader,
    QuarantineRecommendation,
    SELECTOR_SYSTEM_PROMPT,
    SuggestedTest,
    TestCatalog,
    buildSelectionPrompt,
    buildSelectorTools,
} from "@autonoma/investigation";
import { Output, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { resolvePrMeta } from "../src/codebase/pr-meta";
import { withSnapshotContext } from "../src/codebase/resolve";
import { env } from "../src/env";
import { createModelSession } from "../src/services";

/** SelectionResult + a forced explanation of the propose/skip decision. */
const DebugResult = z.object({
    affected: z.array(AffectedTestSelection),
    proposalDecision: z.enum(["propose", "skip"]),
    proposalReasoning: z.string().describe("WHY you proposed a new test, or WHY you skipped - be specific."),
    suggested: z.array(SuggestedTest),
    quarantine: z.array(QuarantineRecommendation),
});

async function main(): Promise<void> {
    const snapshotId = process.argv[2];
    if (snapshotId == null) throw new Error("usage: eval-why-skip.ts <snapshotId>");

    await withSnapshotContext(snapshotId, `whyskip-${snapshotId}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const session = createModelSession();
        const catalog = new TestCatalog(db);
        const tools = buildSelectorTools({
            codebase: reader,
            catalog,
            snapshotId,
            reasoningModel: session.getModel({ model: "classifier", tag: "why-skip" }),
            maxSteps: env.INVESTIGATION_SELECT_MAX_STEPS,
        });
        const diffStat = await reader.diffStat();
        const list = await catalog.listSnapshotTestCases(snapshotId, context.createdAt);
        const result = await generateText({
            model: session.getModel({ model: "classifier", tag: "why-skip" }),
            system: SELECTOR_SYSTEM_PROMPT,
            tools,
            stopWhen: stepCountIs(env.INVESTIGATION_SELECT_MAX_STEPS),
            output: Output.object({ schema: DebugResult }),
            prompt: buildSelectionPrompt(
                { appSlug: context.appSlug, prNumber: prMeta.prNumber, prTitle: prMeta.prTitle, prBody: prMeta.prBody },
                diffStat,
                list,
            ),
        });
        console.log(JSON.stringify(result.output, null, 2));
    });
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
