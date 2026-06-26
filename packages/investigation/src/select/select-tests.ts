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

const SELECTION_TIMEOUT_MS = 5 * 60_000;

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
    // The whole catalog (slug + flow + description) goes in the prompt up front - progressive disclosure, so
    // the model always sees every test instead of relying on a tool it may skip.
    const catalog = await deps.catalog.listTestCases(deps.applicationId, deps.testsCreatedBefore);
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
        { label: "selection" },
    );

    logger.info("Tests selected", {
        extra: { affected: selection.output.affected.length, suggested: selection.output.suggested.length },
    });
    return selection.output;
}
