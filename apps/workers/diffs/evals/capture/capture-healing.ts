import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@autonoma/db";
import { bucketIterationOutcomes } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { createGithubApp } from "../../src/create-services";
import { assembleHealingInput } from "../../src/refinement/assemble-healing-input";
import { requireCasesDir } from "../framework/cases-dir";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { serializeHealingInput } from "../healing/healing-input";
import { buildHealingExpected } from "./healing-expected-scaffold";
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
    const outcomes = await bucketIterationOutcomes(db, iterationId, logger);

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
    await writeFile(
        path.join(caseDir, "expected.md"),
        buildHealingExpected(`iteration ${iterationId}`, frozenInput.failures, frozenInput.candidates),
        "utf-8",
    );

    logger.info("Captured healing case", {
        extra: {
            caseDir,
            failures: frozenInput.failures.length,
            candidates: frozenInput.candidates.length,
            priorActions: frozenInput.priorActions.length,
            scenarios: frozenInput.planAuthoring.scenarios.length,
            flows: frozenInput.planAuthoring.flows.length,
        },
    });

    return caseDir;
}
