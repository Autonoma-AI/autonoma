import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@autonoma/db";
import { readPrDiffStat } from "@autonoma/diffs";
import { PriorRuns } from "@autonoma/diffs/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import { SELF_HEAL_RERUN_REASON } from "@autonoma/types";
import { buildRunFacts, describeProvision, loadGenerationRow } from "../../src/activities/classify-run";
import { resolvePrMeta } from "../../src/codebase/pr-meta";
import { loadSnapshotMeta, resolveGitHubAccess } from "../../src/codebase/snapshot-context";
import { createGithubApp } from "../../src/create-services";
import { type ProductionCapabilities, serializeClassifierInput } from "../classifier/classifier-input";
import { requireCasesDir } from "../framework/cases-dir";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureClassifierParams {
    /** The `AnalysisClassification` to freeze - one classifier invocation. */
    classificationId: string;
    /** Case folder name (defaults to the classification id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a Classifier eval case from a real classification.
 *
 * A case is ONE `AnalysisClassification`: iteration 2 of a finding is a separate row with its own generation
 * and its own `priorPass`, so a self-heal re-run is capturable in its own right and exercises a prompt path
 * iteration 1 never reaches.
 *
 * Everything the classifier reasons from is reassembled through the SAME helpers the production activity uses,
 * so a frozen case cannot quietly diverge from what production classified. The one thing capture computes
 * rather than reads is the prior-runs baseline, bounded to the classification's own timestamp so runs recorded
 * afterwards cannot leak into it.
 */
export async function captureClassifier(params: CaptureClassifierParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureClassifier" });
    const { classificationId } = params;
    const name = params.name ?? classificationId;
    const caseDir = path.join(requireCasesDir("classifier"), name);

    logger.info("Capturing classifier case", { extra: { classificationId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const classification = await loadClassification(classificationId);
    const snapshotId = classification.finding.reportSnapshotId;
    const slug = classification.finding.testCase.slug;

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);
    // Rehydrate through the same cache path the eval uses. It validates SHA-fetchability, so a case whose head
    // was force-pushed away is refused here instead of failing every future run of the suite; and its checkout
    // is the clone the diff stat is read from, so capture never clones the repo twice.
    const codebase = await ensureCachedCheckout(coords, { githubApp });

    const meta = await loadSnapshotMeta(snapshotId);
    const github = await resolveGitHubAccess(meta);
    const [prMeta, diffSummary, generation] = await Promise.all([
        resolvePrMeta({
            branchId: meta.branchId,
            githubRepositoryId: meta.githubRepositoryId,
            githubClient: github.githubClient,
        }),
        readPrDiffStat({ root: codebase.root, baseSha: coords.baseSha, headSha: coords.headSha }),
        loadGenerationRow(classification.generationId),
    ]);

    // The one key production would classify from, resolved exactly as `buildRunArtifacts` resolves it: the
    // dead-time-stripped mp4 when the optimizer produced one, the original webm otherwise.
    const videoKey = generation.optimizedVideoUrl ?? generation.videoUrl;
    const run = buildRunFacts(generation);

    const priorRuns = new PriorRuns(db);
    const baseline = PriorRuns.formatBaseline(
        await priorRuns.getHistory(meta.applicationId, slug, classification.createdAt),
    );

    const frozenInput = serializeClassifierInput({
        coords,
        appSlug: meta.appSlug,
        prNumber: prMeta.prNumber,
        test: {
            slug,
            plan: generation.testPlan.prompt,
            affectedReason: resolveAffectedReason(classification),
        },
        provision: describeProvision(generation),
        diffSummary,
        prTitle: prMeta.prTitle,
        prBody: prMeta.prBody,
        priorPass: await loadPriorPass(classification),
        run,
        recording:
            videoKey != null ? { key: videoKey, isOptimizedMp4: generation.optimizedVideoUrl != null } : undefined,
        finalScreenshotKey: generation.finalScreenshot ?? undefined,
        baseline,
        productionCapabilities: await resolveProductionCapabilities(github.repoFullName, prMeta.prNumber),
    });

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(classification, slug), "utf-8");

    logger.info("Captured classifier case", {
        extra: {
            caseDir,
            slug,
            capturedCategory: classification.category,
            steps: frozenInput.run.inspectableSteps.length,
            hasRecording: frozenInput.run.recording != null,
        },
    });

    return caseDir;
}

/** The classification row plus the finding context a case needs, refusing anything that is not replayable. */
async function loadClassification(classificationId: string) {
    const classification = await db.analysisClassification.findUniqueOrThrow({
        where: { id: classificationId },
        select: {
            number: true,
            category: true,
            confidence: true,
            createdAt: true,
            generationId: true,
            findingId: true,
            finding: {
                select: {
                    reportSnapshotId: true,
                    selectionReason: true,
                    // Whether the test pre-existed or was authored this run. Not part of the classifier's
                    // input - it reaches the author through the scaffold, because a verdict on a test that was
                    // written moments earlier reads very differently from one on a long-standing test.
                    origin: true,
                    testCase: { select: { slug: true } },
                },
            },
        },
    });

    // A null confidence is a CONTAINED fault - the workflow recorded a category for a run no classifier ever
    // saw. There is no classification to replay, so freezing one would create a case that can only ever grade
    // the containment path against a classifier that was never asked.
    if (classification.confidence == null) {
        throw new Error(
            `Classification ${classificationId} was contained (${classification.category}) rather than classified: ` +
                "no classifier ran, so there is nothing to replay. Pick a row with a confidence.",
        );
    }

    return classification;
}

type LoadedClassification = Awaited<ReturnType<typeof loadClassification>>;

/**
 * What the classifier was told about WHY this test was being looked at.
 *
 * Iteration 1 gets the finding's recorded selection reason. Every later iteration is a self-heal re-run, whose
 * reason is a fixed line the loop substitutes and never persists - so it is reproduced from the shared
 * constant rather than read back.
 */
function resolveAffectedReason(classification: LoadedClassification): string {
    if (classification.number > 1) return SELF_HEAL_RERUN_REASON;
    return classification.finding.selectionReason ?? "";
}

/**
 * The preceding iteration's verdict, which a self-heal re-run is judged against. Read from the classification
 * one slot earlier on the same finding - the row the loop's own `priorPass` was built from.
 */
async function loadPriorPass(
    classification: LoadedClassification,
): Promise<{ category: string; headline: string; rootCause?: string } | undefined> {
    if (classification.number <= 1) return undefined;

    const prior = await db.analysisClassification.findFirst({
        where: { findingId: classification.findingId, number: classification.number - 1 },
        select: { category: true, headline: true, rootCause: true },
    });
    if (prior == null) return undefined;

    return { category: prior.category, headline: prior.headline, rootCause: prior.rootCause ?? undefined };
}

/**
 * Which live-infra tools production had for this PR, approximated at capture time.
 *
 * Production gated the preview tools on whether previewkit deployed this PR, and the log tool on that plus a
 * Loki endpoint being configured - the same two facts read here. It is an approximation because both are read
 * NOW rather than at classification time; it is recorded so a case says plainly what its replay cannot serve,
 * not to reconstruct the toolset.
 */
async function resolveProductionCapabilities(repoFullName: string, prNumber: number): Promise<ProductionCapabilities> {
    if (prNumber === 0) return { previewEnv: false, previewScript: false, appLogs: false };

    const [previewEnv, { env }] = await Promise.all([
        db.previewkitEnvironment.findUnique({
            where: { repoFullName_prNumber: { repoFullName, prNumber } },
            select: { namespace: true },
        }),
        import("../../src/env"),
    ]);

    const previewIntegrated = previewEnv != null;
    const lokiConfigured = env.LOKI_URL != null && env.LOKI_URL !== "";
    return {
        previewEnv: previewIntegrated,
        previewScript: previewIntegrated,
        appLogs: previewIntegrated && lokiConfigured,
    };
}

function blankExpected(classification: LoadedClassification, slug: string): string {
    const origin = classification.finding.origin ?? "unknown";
    return `---
description: "${slug} (${origin}, iteration ${classification.number}) - TODO: describe what this case exercises"
skip: true
# What production said the day this case was frozen. Provenance only - never edited.
capturedCategory: ${classification.category}
# The verdict this case ASSERTS. Deliberately left blank: decide it yourself from the
# evidence rather than ratifying the line above, then set skip: false.
# category: ${classification.category}
# planFidelity: exact | partial | diverged
# expectRewrite: true    # a plan_mismatch must carry a revised plan; false when the
#                        # right answer is no viable rewrite (the loop keeps the test)
# runs: 1                # >1 requires EVERY run to pass, which measures stability
---

TODO: author the LLM-judge rubric here.

The judge sees only the classifier's structured verdict plus this body - never the
codebase, the recording, or the screenshots. Grade what the deterministic checks above
cannot express:
  - Does the stated root cause actually follow from the cited evidence, or is the
    verdict right for the wrong reason?
  - Is expectedBehavior/actualBehavior (or whatHappened) specific about what the app
    did, rather than restating the test steps?
  - For a client_bug: does falsePositiveRisk engage with the strongest case that this
    is intended behavior, or is it filler?
  - For a plan_mismatch: does the revised plan target what the app NOW does, rather
    than deleting the assertion that failed?
Keep every point checkable from the verdict alone, and additive to the frontmatter.
`;
}
