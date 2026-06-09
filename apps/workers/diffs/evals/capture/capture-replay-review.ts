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
import { serializeReplayReviewInput } from "../replay-review/replay-review-input";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureReplayReviewParams {
    runId: string;
    /** Case folder name (defaults to the run id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a replay review eval case from a live run.
 *
 * Mirrors `captureGenerationReview`: resolves the run's snapshot coords,
 * validates SHA fetchability, loads the production `RunContext`, probes every
 * referenced S3 key, freezes the context to `input.json`, and scaffolds a
 * blank `expected.md`.
 *
 * **Failure-only**: the replay reviewer is failure-only in production
 * (`runReplayReview` skips non-`failed` runs), so we refuse to capture a case
 * from a run whose status is not `"failed"`.
 */
export async function captureReplayReview(params: CaptureReplayReviewParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureReplayReview" });
    const { runId } = params;
    const name = params.name ?? runId;
    const caseDir = path.join(requireCasesDir("replay-review"), name);

    logger.info("Capturing replay review case", { extra: { runId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const { snapshotId, status } = await resolveRunMetadata(runId);
    if (status !== "failed") {
        throw new Error(
            `Run ${runId} has status "${status}" - replay review is failure-only, so only failed runs can be captured`,
        );
    }

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Rehydrate through the same cache path the eval uses, validating
    // SHA-fetchability up front so we never write a case with a dead clone.
    await ensureCachedCheckout(coords, { githubApp });

    const storage = S3Storage.createFromEnv();
    const evidenceLoader = new StorageEvidenceLoader(storage);
    const contextLoader = new DiffJobContextLoader(db);
    const context = await contextLoader.load(runId);

    // Refuse to write a case whose media is no longer reachable.
    const screenshots: string[] = [];
    for (const step of context.steps) {
        if (step.screenshotBeforeKey != null) screenshots.push(step.screenshotBeforeKey);
        if (step.screenshotAfterKey != null) screenshots.push(step.screenshotAfterKey);
    }
    const evidenceKeys: Parameters<typeof probeEvidence>[0] = { screenshots };
    if (context.finalScreenshotKey != null) evidenceKeys.finalScreenshot = context.finalScreenshotKey;
    if (context.videoS3Key != null) evidenceKeys.video = context.videoS3Key;
    await probeEvidence(evidenceKeys, evidenceLoader);

    const frozen = serializeReplayReviewInput(coords, context);

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozen, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(runId), "utf-8");

    logger.info("Captured replay review case", { extra: { caseDir, steps: frozen.context.steps.length } });

    return caseDir;
}

async function resolveRunMetadata(runId: string): Promise<{ snapshotId: string; status: string }> {
    const run = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
            status: true,
            assignment: { select: { snapshotId: true } },
        },
    });
    if (run.assignment.snapshotId == null) {
        throw new Error(`Run ${runId} has no assignment.snapshotId`);
    }
    return { snapshotId: run.assignment.snapshotId, status: run.status };
}

function blankExpected(runId: string): string {
    return `---
description: "Captured from run ${runId} - TODO: describe what this case exercises"
skip: true
# Deterministic check (uncomment + fill in, then set skip: false):
# verdict: application_bug   # one of: engine_error | application_bug
---

TODO: author the LLM-judge rubric here.

The judge sees only the reviewer's structured verdict plus this body - never the
codebase, screenshots, or video. Grade qualities the deterministic verdict
check above cannot express:

- Does the reasoning cite the actual failure point (matches the failurePoint step)?
- Are there any hallucinated steps in the reasoning that don't exist in the run?
- Is the engine-vs-app-bug attribution correct given what the video shows?

Keep every point additive to the frontmatter, and phrase each as something
checkable from the verdict's reasoning/failurePoint/evidence alone.
`;
}

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-replay-review-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [runId] = positionals;

    if (runId == null) {
        throw new Error("Missing <runId>. Usage: capture:replay-review <runId> [--name <case-name>] [--force]");
    }

    const captureParams: CaptureReplayReviewParams = { runId, force: values.force };
    if (values.name != null) captureParams.name = values.name;

    const caseDir = await captureReplayReview(captureParams);

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured replay review case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-replay-review-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
