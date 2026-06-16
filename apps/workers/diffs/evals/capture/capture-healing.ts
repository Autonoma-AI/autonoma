import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bucketIterationOutcomes } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { createGithubApp } from "../../src/create-services";
import { assembleHealingInput } from "../../src/refinement/assemble-healing-input";
import { requireCasesDir } from "../framework/cases-dir";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { serializeHealingInput } from "../healing/healing-input";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureHealingParams {
    iterationId: string;
    /** Case folder name (defaults to the iteration id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a Healing eval case from a live refinement iteration.
 *
 * Buckets the iteration's plan outcomes the same way `analyzeResults` does,
 * resolves the iteration's snapshot's git coordinates, validates both SHAs are
 * fetchable (refusing to write a case otherwise), runs the shared Healing
 * side-input loaders against a real codebase clone, freezes the assembled
 * `HealingInput` to `input.json` (codebase as coords, `FlowIndex` / `ScenarioIndex`
 * as arrays), and scaffolds a blank `expected.md` (`skip: true`) for the author
 * to fill in.
 */
export async function captureHealing(params: CaptureHealingParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureHealing" });
    const { iterationId } = params;
    const name = params.name ?? iterationId;
    const caseDir = path.join(requireCasesDir("healing"), name);

    logger.info("Capturing healing case", { extra: { iterationId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    // Reproduce what analyzeResults did at production time: bucket the
    // iteration's plan outcomes into success / failed-at-generation /
    // failed-at-replay. These reads only touch immutable rows (TestGeneration,
    // Run, their reviews) so they reproduce exactly what the live iteration saw.
    const outcomes = await bucketIterationOutcomes(iterationId, logger);

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(outcomes.snapshotId, githubApp);

    // Rehydrate through the same cache path the eval uses. This validates
    // SHA-fetchability (throws UnfetchableShaError on a dead SHA, so we never
    // write an unrunnable case) and gives downstream loaders a real working tree.
    await ensureCachedCheckout(coords, { githubApp });

    const { agentInput } = await assembleHealingInput({
        iterationId,
        iterationNumber: outcomes.iterationNumber,
        snapshotId: outcomes.snapshotId,
        failuresAtGeneration: outcomes.failuresAtGeneration,
        failuresAtReplay: outcomes.failuresAtReplay,
    });

    const frozenInput = serializeHealingInput(coords, agentInput, agentInput.planAuthoring.scenarios.toArray());

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(iterationId, frozenInput.failures), "utf-8");

    logger.info("Captured healing case", {
        extra: {
            caseDir,
            failures: frozenInput.failures.length,
            priorActions: frozenInput.priorActions.length,
            scenarios: frozenInput.planAuthoring.scenarios.length,
            flows: frozenInput.planAuthoring.flows.length,
        },
    });

    return caseDir;
}

function blankExpected(iterationId: string, failures: { testCaseId: string; testCaseSlug: string }[]): string {
    const expectedLines = failures.map(
        (f) =>
            `#   ${f.testCaseId}: update_plan   # ${f.testCaseSlug} - pick: update_plan | report_bug | report_engine_limitation | remove_test`,
    );
    const expectedBlock =
        expectedLines.length > 0 ? expectedLines.join("\n") : "#   (no failing test cases in this iteration)";

    return `---
description: "Captured from iteration ${iterationId} - TODO: describe what this case exercises"
skip: true
# Deterministic check (uncomment + fill in, then set skip: false).
# One entry per failing test case in input.json; the keyset must match exactly,
# and each value is the action kind that test case should receive.
# expectedActions:
${expectedBlock}
---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic check cannot express:
  - For each \`update_plan\`: does the \`newPrompt\` address the cited failure?
    Is it specific enough? Does it preserve the test's original intent?
  - For each \`report_bug\` / \`report_engine_limitation\`: is the triage correct
    (application defect vs. engine/agent limitation)? Are the description and
    severity proportionate to the cited reasoning?
  - For each \`remove_test\`: is the cited reason plausible given the failure
    context (e.g. feature removed from the app)?
Keep every point additive to the frontmatter, and phrase each as something
checkable from the structured output alone.
`;
}
