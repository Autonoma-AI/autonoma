import { logger as rootLogger } from "@autonoma/logger";
import { Output, generateText, stepCountIs } from "ai";
import { withRetry } from "../retry";
import type { SelectorDeps } from "./dependencies";
import { SELECTOR_SYSTEM_PROMPT, buildSelectionPrompt } from "./prompt";
import { SelectionResult } from "./schema";
import { buildSelectorTools } from "./tools";

/** The static facts about the PR whose affected tests we're selecting. */
export interface SelectContext {
    appSlug: string;
    prNumber: number;
    prTitle?: string;
    prBody?: string;
}

// The select tool loop (up to maxSteps gpt-5.5 calls) on a large app (1,300+ tests) runs well past 5 min; that
// cap aborted mid-loop and burned 3 retries (~15 min) without ever finishing. Give it one generous window that
// still fits the 20-min Temporal activity ceiling (clone + catalog load take ~1.5 min on top of this).
const SELECTION_TIMEOUT_MS = 12 * 60_000;

/**
 * Select the existing tests a PR's diff affects (and suggest new ones for uncovered behavior). Mirrors the
 * classifier's structure - prompt, tools, schema in their own modules; every capability injected.
 */
export async function selectAffectedTests(context: SelectContext, deps: SelectorDeps): Promise<SelectionResult> {
    const logger = rootLogger.child({
        name: "selectAffectedTests",
        extra: { appSlug: context.appSlug, prNumber: context.prNumber },
    });
    logger.info("Selecting affected tests");

    const tools = buildSelectorTools(deps);
    const diffStat = await deps.codebase.diffStat();
    // The snapshot's assigned tests (slug + flow + pinned-plan description) go in the prompt up front -
    // progressive disclosure, so the model always sees every candidate instead of relying on a tool it may skip.
    // Cut off at the snapshot's createdAt so the deployed agent's same-PR test creations (assigned onto the twin
    // after the fork) never leak in and make us look "already covered" for behavior we should propose a test for.
    const catalog = await deps.catalog.listSnapshotTestCases(deps.snapshotId, deps.testsCreatedBefore);
    logger.info("Catalog loaded for selection", { extra: { tests: catalog.length } });

    const selection = await withRetry(
        () =>
            generateText({
                model: deps.reasoningModel,
                system: SELECTOR_SYSTEM_PROMPT,
                tools,
                stopWhen: stepCountIs(deps.maxSteps),
                output: Output.object({ schema: SelectionResult }),
                prompt: buildSelectionPrompt(context, diffStat, catalog),
                abortSignal: AbortSignal.timeout(SELECTION_TIMEOUT_MS),
            }),
        // tries: 1 - a timeout means the loop is slow, not flaky, and a resend re-runs the whole 12-min loop,
        // which would blow the 20-min activity ceiling. The per-run output budget keeps each call small.
        { label: "selection", tries: 1 },
    );

    logger.info("Tests selected", {
        extra: { affected: selection.output.affected.length, suggested: selection.output.suggested.length },
    });
    return selection.output;
}
