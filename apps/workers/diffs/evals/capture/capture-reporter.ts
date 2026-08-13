import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageEvidenceLoader } from "@autonoma/diffs";
import {
    type ReporterInputPayload,
    reporterInputPayloadSchema,
    reporterInputStorageKey,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { createGithubApp } from "../../src/create-services";
import { getStorage } from "../../src/services";
import { ensureCachedCheckout, probeEvidence } from "../framework";
import { casesDir } from "../framework/cases-dir";
import { reporterCaseInputSchema } from "../reporter/reporter-input";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureReporterParams {
    snapshotId: string;
    /** Case folder name (defaults to the snapshot id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a Reporter eval case from a live snapshot.
 *
 * Unlike the Analysis and Classifier captures, this one does NOT reconstruct the agent's input from the DB: the
 * Reporter reasons over the branch's issues, which are mutated in place across snapshots (a carried-forward issue
 * overwrites its own narrative), so a reconstruction weeks later would read the captured run's own answer back into
 * its input. Instead the Reporter serializes its assembled input to S3 at report birth, and capture reads that blob
 * back - the only faithful option, and why the corpus is forward-only (a snapshot whose Reporter ran before the
 * serializer shipped has no blob to capture).
 *
 * The blob carries everything except the git coords (immutable snapshot facts); those are re-resolved from the DB
 * and both SHAs validated fetchable, so a case with a dead SHA is never written. Every referenced screenshot key is
 * probed against S3 before the case is written, so a case whose media has rotated away is refused rather than frozen
 * unrunnable.
 */
export async function captureReporter(params: CaptureReporterParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureReporter" });
    const { snapshotId } = params;
    const name = params.name ?? snapshotId;
    const caseDir = path.join(casesDir("reporter"), name);

    logger.info("Capturing reporter case", { extra: { snapshotId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const storage = getStorage();
    const payload = await downloadPayload(storage, snapshotId, logger);

    // Resolve coords and validate both SHAs are fetchable (throws UnfetchableShaError on a dead SHA), rehydrating
    // through the same cache path the eval uses so we never write a case that cannot be re-run.
    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);
    await ensureCachedCheckout(coords, { githubApp });

    // The blob stores media as S3 keys; probe every one so a case whose screenshots have rotated away is refused,
    // not frozen unrunnable.
    const screenshots = collectScreenshotKeys(payload);
    await probeEvidence({ screenshots }, new StorageEvidenceLoader(storage), { logger });

    const frozenInput = reporterCaseInputSchema.parse({ codebase: coords, ...payload });

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(snapshotId), "utf-8");

    logger.info("Captured reporter case", {
        extra: {
            caseDir,
            findings: payload.findings.length,
            branchTests: payload.branchTests.length,
            existingIssues: payload.existingIssues.length,
            screenshots: screenshots.length,
        },
    });

    return caseDir;
}

/** Download and parse the frozen input blob. A missing blob and a drifted blob get distinct, correct messages. */
async function downloadPayload(
    storage: StorageProvider,
    snapshotId: string,
    logger: Logger,
): Promise<ReporterInputPayload> {
    const key = reporterInputStorageKey(snapshotId);
    logger.info("Downloading reporter input snapshot", { extra: { key } });
    const raw = await downloadBlob(storage, key, snapshotId);
    try {
        return reporterInputPayloadSchema.parse(JSON.parse(raw.toString("utf-8")));
    } catch (err) {
        // The bytes WERE present - so this is not a missing run. A schema mismatch means the payload shape has
        // drifted since this blob was written; re-running the Reporter refreshes it.
        throw new Error(
            `The reporter input snapshot at ${key} exists but does not match the current schema (it likely ` +
                `drifted since it was written). Re-run the Reporter for snapshot ${snapshotId} to refresh it.`,
            { cause: err },
        );
    }
}

/** Fetch the blob's bytes. An absent object is the expected forward-only miss, reported as exactly that. */
async function downloadBlob(storage: StorageProvider, key: string, snapshotId: string): Promise<Buffer> {
    try {
        return await storage.download(key);
    } catch (err) {
        throw new Error(
            `No reporter input snapshot at ${key}. The Reporter must have run for snapshot ${snapshotId} AFTER ` +
                `the input serializer shipped - this corpus is forward-only, so an older run has no blob to capture.`,
            { cause: err },
        );
    }
}

/** Every distinct screenshot key the frozen findings reference, for the pre-write S3 existence probe. */
function collectScreenshotKeys(payload: ReporterInputPayload): string[] {
    const keys = new Set<string>();
    for (const finding of payload.findings) {
        for (const asset of finding.screenshots) keys.add(asset.s3Key);
    }
    return [...keys];
}

function blankExpected(snapshotId: string): string {
    return `---
description: "Captured from snapshot ${snapshotId} - TODO: describe what this case exercises"
skip: true
# Deterministic checks (provisional shape - the reporter eval PR finalizes the frontmatter schema). Uncomment,
# fill in, then set skip: false. The headline assertion is the dedup call: whether this run's finding is the SAME
# problem as an existing issue (carry_forward) or a new one (open). The coverage guarantees self-heal, so they are
# NOT asserted here.
# issues:
#   open: { minCount: 0, maxCount: 0 }   # how many brand-new issues this run should open
#   carryForward: [ ]                     # existing issue ids that MUST be carried forward (the dedup call)
#   resolve: [ ]                          # existing issue ids that MUST be resolved
# issueDetails:                           # per asserted issue: its kind + severity (not self-healed)
#   - id: <existingIssueId>
#     kind: bug                           # bug | environment | scenario
#     severity: high                      # critical | high | medium | low
# flows:                                  # flow membership - which flow a test lands in (the agent's call)
#   - title: <flow name>
#     include: [ ]                        # slugs that MUST be clustered into this flow
# maxSweptSlugs: 0                        # flowCorrections budget (recorded metric; unknownSlugs is always 0)
# runs: 1                                 # >1 requires EVERY run to pass (stability measurement)
---

TODO: author the LLM-judge rubric here.

The judge sees only the Reporter's structured output plus this body - never the codebase, the screenshots, or the
diff. Groundedness (a real file:line, the right frame) is enforced by the result tool at author time, so do NOT
grade it. Grade what the deterministic checks cannot:
  - Does the report read as the whole PR's cumulative state, not just this snapshot's counts?
  - Are the flows clustered into units a reader recognizes (a feature/journey), with one flow able to hold both
    passing and failing tests?
  - Are the title and headline honest given the derived flow statuses - no win erased, no gap hidden?
  - Is each issue's severity call defensible from its narrative?
Keep every point additive to the frontmatter, and phrase each as something checkable from the output alone.
`;
}
