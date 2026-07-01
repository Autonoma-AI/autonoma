import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { db } from "@autonoma/db";
import { StorageEvidenceLoader } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { createGithubApp } from "../../src/create-services";
import { DiffJobContextLoader } from "../../src/review/diff-job-context-loader";
import { requireCasesDir } from "../framework/cases-dir";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { probeEvidence } from "../framework/evidence-probe";
import { serializeGenerationReviewInput } from "../generation-review/generation-review-input";
import { recoverScenarioDataForGeneration } from "./recover-scenario-data-for-generation";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureGenerationReviewParams {
    generationId: string;
    /** Case folder name (defaults to the generation id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a generation review eval case from a live generation.
 *
 * Resolves the generation's snapshot git coordinates, validates both SHAs are
 * fetchable (refusing to write a case otherwise), loads the production
 * generation context (DB + S3-keyed media), probes every referenced S3 key for
 * downloadability, freezes the `GenerationContext` to `input.json` (codebase
 * as coords, conversation sanitized in-place, multimedia as keys not bytes),
 * and scaffolds a blank `expected.md` (`skip: true`) for the author to fill in.
 */
export async function captureGenerationReview(params: CaptureGenerationReviewParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureGenerationReview" });
    const { generationId } = params;
    const name = params.name ?? generationId;
    const caseDir = path.join(requireCasesDir("generation-review"), name);

    logger.info("Capturing generation review case", { extra: { generationId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const githubApp = createGithubApp();
    const snapshotId = await resolveGenerationSnapshotId(generationId);
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Rehydrate through the same cache path the eval uses, validating
    // SHA-fetchability up front so we never write a case with a dead clone.
    await ensureCachedCheckout(coords, { githubApp });

    const storage = S3Storage.createFromEnv();
    const evidenceLoader = new StorageEvidenceLoader(storage);
    const contextLoader = new DiffJobContextLoader(db, storage);
    const context = await contextLoader.loadGeneration(generationId);

    // Pre-#822 instances have a null generatedData, so the loader omits the
    // scenario; recover the create graph from the UP webhook_call (eval-only).
    if (context.scenario == null) {
        const recovered = await recoverScenarioDataForGeneration(db, generationId);
        if (recovered != null) {
            context.scenario = recovered;
            logger.info("Recovered legacy scenario data from webhook log", { extra: { generationId } });
        }
    }

    // Refuse to write a case whose media is no longer reachable - parallel to
    // refusing dead SHAs above.
    const screenshots: string[] = [];
    for (const step of context.steps) {
        if (step.screenshotBeforeKey != null) screenshots.push(step.screenshotBeforeKey);
        if (step.screenshotAfterKey != null) screenshots.push(step.screenshotAfterKey);
    }
    const evidenceKeys: Parameters<typeof probeEvidence>[0] = {
        screenshots,
        finalScreenshot: context.finalScreenshotKey,
        video: context.videoUrl,
    };
    await probeEvidence(evidenceKeys, evidenceLoader);

    const frozen = serializeGenerationReviewInput(coords, context);

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozen, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(generationId), "utf-8");

    logger.info("Captured generation review case", {
        extra: { caseDir, steps: frozen.context.steps.length, conversationLength: frozen.context.conversation.length },
    });

    return caseDir;
}

async function resolveGenerationSnapshotId(generationId: string): Promise<string> {
    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: { snapshotId: true },
    });
    if (generation.snapshotId == null) {
        throw new Error(`Generation ${generationId} has no snapshotId`);
    }
    return generation.snapshotId;
}

function blankExpected(generationId: string): string {
    return `---
description: "Captured from generation ${generationId} - TODO: describe what this case exercises"
skip: true
# Deterministic check (uncomment + fill in, then set skip: false):
# verdict: success   # one of: success | agent_limitation | application_bug | plan_mismatch | unknown_issue | scenario_unsupported
---

TODO: author the LLM-judge rubric here.

The judge sees only the reviewer's structured verdict plus this body - never the
codebase, conversation, screenshots, or video. Grade qualities the deterministic
verdict check above cannot express:

- Does the reasoning cite the actual failure point (matches the failurePoint step)?
- Are there any hallucinated steps in the reasoning that don't exist in the run?
- Is the engine-vs-app-bug attribution correct given what the video shows?

Keep every point additive to the frontmatter, and phrase each as something
checkable from the verdict's reasoning/failurePoint/evidence alone.
`;
}

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-generation-review-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [generationId] = positionals;

    if (generationId == null) {
        throw new Error(
            "Missing <generationId>. Usage: capture:generation-review <generationId> [--name <case-name>] [--force]",
        );
    }

    const captureParams: CaptureGenerationReviewParams = { generationId, force: values.force, name: values.name };

    const caseDir = await captureGenerationReview(captureParams);

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured generation review case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-generation-review-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
