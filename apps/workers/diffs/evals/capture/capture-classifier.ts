import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@autonoma/db";
import { readPrDiffStat } from "@autonoma/diffs";
import { PreviewEnvironment, PriorRuns, readPreviewConnectionKeys } from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { SELF_HEAL_RERUN_REASON } from "@autonoma/types";
import { buildRunFacts, describeProvision, loadGenerationRow } from "../../src/activities/classify-run";
import { resolvePrMeta } from "../../src/codebase/pr-meta";
import { loadSnapshotMeta, resolveGitHubAccess } from "../../src/codebase/snapshot-context";
import { createGithubApp } from "../../src/create-services";
import { previewSecrets } from "../../src/preview-secrets";
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
 * so a frozen case cannot quietly diverge from what production classified. Two things capture computes rather
 * than reads, and both are bounded to the classification's own timestamp because the source behind them is
 * mutable: the prior-runs baseline, so runs recorded afterwards cannot leak into it, and the preview's env-var
 * names, so a secret stored afterwards cannot read as configured on a run that saw it absent.
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

    // The two mutable sources, reconstructed as of the same instant and read together - neither needs the other.
    const priorRuns = new PriorRuns(db);
    const [history, preview] = await Promise.all([
        priorRuns.getHistory(meta.applicationId, slug, classification.createdAt),
        freezePreviewFacts(github.repoFullName, prMeta.prNumber, meta.applicationId, classification.createdAt, logger),
    ]);
    const baseline = PriorRuns.formatBaseline(history);

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
        previewEnvNames: preview.previewEnvNames,
        productionCapabilities: preview.capabilities,
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
            previewEnvNames: preview.previewEnvNames?.length,
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

/** What a case records about the PR's preview: which live tools production had, and what a replay can serve. */
interface FrozenPreviewFacts {
    capabilities: ProductionCapabilities;
    /** The pod's full env-var name list, or undefined when it could not be frozen in full. */
    previewEnvNames?: string[];
}

/**
 * The preview facts a case carries: which live-infra tools production had, approximated at capture time, and
 * the env-var names a replay serves `get_preview_env` from.
 *
 * Production gated the preview tools on whether previewkit deployed this PR, and the log tool on that plus a
 * Loki endpoint being configured - the same two facts read here. The capabilities are an approximation because
 * both are read NOW rather than at classification time; they are recorded so a case says plainly what its
 * replay cannot serve, not to reconstruct the toolset.
 */
async function freezePreviewFacts(
    repoFullName: string,
    prNumber: number,
    applicationId: string,
    classifiedAt: Date,
    logger: Logger,
): Promise<FrozenPreviewFacts> {
    if (prNumber === 0) return { capabilities: { previewEnv: false, previewScript: false, appLogs: false } };

    const [previewEnvironment, { env }] = await Promise.all([
        db.previewkitEnvironment.findUnique({
            where: { repoFullName_prNumber: { repoFullName, prNumber } },
            select: { resolvedConfig: true },
        }),
        import("../../src/env"),
    ]);

    const previewIntegrated = previewEnvironment != null;
    const lokiConfigured = env.LOKI_URL != null && env.LOKI_URL !== "";
    const capabilities: ProductionCapabilities = {
        previewEnv: previewIntegrated,
        previewScript: previewIntegrated,
        appLogs: previewIntegrated && lokiConfigured,
    };
    if (previewEnvironment == null) return { capabilities };

    const previewEnvNames = await freezeEnvVarNames({
        resolvedConfig: previewEnvironment.resolvedConfig,
        applicationId,
        classifiedAt,
        logger,
    });
    return { capabilities, previewEnvNames };
}

interface FreezeEnvVarNames {
    resolvedConfig: unknown;
    applicationId: string;
    classifiedAt: Date;
    logger: Logger;
}

/**
 * Every env-var name the preview pod ran with, read through the SAME {@link PreviewEnvironment} production
 * reads and bounded to the classification. Undefined rather than a partial list - whether the gap is an
 * unreadable config or a bound that erased the bundle; a case without one keeps `get_preview_env` off,
 * exactly as a non-integrated PR does.
 */
async function freezeEnvVarNames({
    resolvedConfig,
    applicationId,
    classifiedAt,
    logger,
}: FreezeEnvVarNames): Promise<string[] | undefined> {
    const connectionKeys = readPreviewConnectionKeys(resolvedConfig, logger);
    if (connectionKeys == null) {
        logger.warn("Refusing to freeze half a preview environment; this case will not serve get_preview_env", {
            extra: { applicationId },
        });
        return undefined;
    }

    const secrets = previewSecrets();
    const target = { applicationId };
    try {
        // The secret BUNDLE either side of the bound, not the unioned list: only the bundle is time-bounded,
        // and only it can be emptied wholesale by a bound that predates when its rows were written.
        const [bundleThen, bundleNow] = await Promise.all([
            secrets.getEnvVarNames(target, classifiedAt),
            secrets.getEnvVarNames(target),
        ]);

        // A bound that excluded the WHOLE bundle has not reconstructed this preview, it has emptied it: what
        // would be frozen is the connection keys alone, a list asserting every secret was absent. Same call as
        // an unreadable config - refuse. `previewkit_secret` rows were bulk-written when preview secrets moved
        // into postgres, so every classification older than that migration lands here.
        if (bundleThen.length === 0 && bundleNow.length > 0) {
            logger.warn(
                "The whole secret bundle postdates this classification, so its environment cannot be " +
                    "reconstructed; this case will not serve get_preview_env",
                { extra: { applicationId, bundleNow: bundleNow.length, classifiedAt } },
            );
            return undefined;
        }

        const addedSince = bundleNow.filter((name) => !bundleThen.includes(name));
        if (addedSince.length > 0) {
            // The bound excludes keys added since. A key DELETED since left no row, so both readings agree and
            // the frozen list silently understates what production read - undetectable, which is why this
            // warns on churn (evidence the bundle is edited at all) rather than on the gap itself.
            logger.warn(
                "This app's secret bundle has been edited since the classification; the keys added after it " +
                    "are excluded, but a key DELETED since cannot be recovered, so the frozen list may still " +
                    "understate what production read",
                { extra: { applicationId, addedSince, bundleThen: bundleThen.length } },
            );
        }

        return await new PreviewEnvironment(secrets, applicationId, connectionKeys, classifiedAt).getEnvVarNames();
    } catch (err) {
        logger.warn("Could not read the preview's stored secrets; this case will not serve get_preview_env", {
            extra: { applicationId },
            err,
        });
        return undefined;
    }
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
