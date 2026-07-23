import { db } from "@autonoma/db";
import {
    LocalCodebaseReader,
    PreviewEnvironment,
    PreviewSecrets,
    PriorRuns,
    type RunArtifacts,
    type RunVideo,
    classifyRun,
    loadPreviewAppLogs,
    persistInvestigationCosts,
} from "@autonoma/investigation";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type InvestigationRunStep, stepOutputDataSchema } from "@autonoma/types";
import type { ClassifyInvestigationRunInput, InvestigationTestResult } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { withSnapshotContext } from "../codebase/resolve";
import { env } from "../env";
import { webmToGif } from "../media/webm-to-gif";
import { createModelSession, getStorage } from "../services";

type AttemptRow = {
    order: number;
    interaction: string;
    status: string;
    error: string | null;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
    output: object | null;
};

type ScenarioInstanceRow = {
    status: string;
    auth: PrismaJson.ScenarioAuth | null;
    refs: PrismaJson.ScenarioRefs | null;
    lastError: PrismaJson.ScenarioLastError | null;
    upAt: Date | null;
    downAt: Date | null;
};

/** Narrow an arbitrary JSON value to a plain object so we can inspect its real runtime shape. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

type GenerationRow = {
    status: string;
    videoUrl: string | null;
    optimizedVideoUrl: string | null;
    finalScreenshot: string | null;
    reasoning: string | null;
    createdAt: Date;
    updatedAt: Date;
    testPlan: { prompt: string };
    scenarioInstance: ScenarioInstanceRow | null;
    attempts: AttemptRow[];
};

/**
 * Classify one shadow run: load its generation row + media, clone the codebase, wire the classifier's
 * dependencies against real infra (Prisma / S3 / preview secrets / the cloned repo / the models / Loki), and
 * run the classifier. get_app_logs is wired to the preview's Loki stream (namespace resolved from the PR's
 * previewkit environment); get_deployment_health (cross-cluster k8s) is not wired yet - it returns a clear
 * "unavailable" note and the classifier degrades gracefully.
 */
export async function classifyInvestigationRun(input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult> {
    const { snapshotId, slug, reason, testGenerationId } = input;
    const logger = rootLogger.child({
        name: "classifyInvestigationRun",
        extra: { snapshotId, slug, testGenerationId },
    });
    logger.info("Classifying shadow run");

    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: testGenerationId },
        select: {
            status: true,
            videoUrl: true,
            optimizedVideoUrl: true,
            finalScreenshot: true,
            reasoning: true,
            createdAt: true,
            updatedAt: true,
            testPlan: { select: { prompt: true } },
            scenarioInstance: {
                select: { status: true, auth: true, refs: true, lastError: true, upAt: true, downAt: true },
            },
            attempts: {
                select: {
                    order: true,
                    interaction: true,
                    status: true,
                    error: true,
                    screenshotBefore: true,
                    screenshotAfter: true,
                    output: true,
                },
                orderBy: { order: "asc" },
            },
        },
    });

    const runArtifacts = await buildRunArtifacts(generation);

    return withSnapshotContext(snapshotId, `classify-${testGenerationId}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const previewNamespace = await resolvePreviewNamespace(context.repoFullName, prMeta.prNumber, logger);
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const session = createModelSession();
        const priorRuns = new PriorRuns(db);

        // Gate the previewkit-dependent tools on whether this PR's preview is actually managed by previewkit. The
        // namespace only resolves for a previewkit-deployed preview; when it does not (a self-hosted / non-integrated
        // client), there is no Loki stream and the backend script harness cannot authenticate - so we omit
        // get_app_logs / run_script / get_preview_env rather than let them fail with confusing errors the classifier
        // mistakes for signal. App logs additionally need LOKI configured on this worker.
        const previewIntegrated = previewNamespace != null;
        const appLogsAvailable = previewIntegrated && env.LOKI_URL != null && env.LOKI_URL !== "";
        const preview = previewIntegrated
            ? new PreviewEnvironment(PreviewSecrets.create(), context.repoFullName)
            : undefined;
        logger.info("Resolved preview introspection availability", {
            extra: { previewIntegrated, appLogsAvailable },
        });

        const verdict = await classifyRun(
            {
                appSlug: context.appSlug,
                prNumber: prMeta.prNumber,
                test: { slug, plan: generation.testPlan.prompt, affectedReason: reason },
                provision: describeProvision(generation),
                diffSummary: await reader.diffStat(),
                prTitle: prMeta.prTitle,
                prBody: prMeta.prBody,
            },
            {
                codebase: reader,
                run: runArtifacts,
                preview,
                loadBaseline: async () => PriorRuns.formatBaseline(await priorRuns.getHistory(context.appSlug, slug)),
                loadAppLogs: appLogsAvailable
                    ? (regex) =>
                          loadPreviewAppLogs({
                              regex,
                              lokiUrl: env.LOKI_URL,
                              namespace: previewNamespace,
                              startEpoch: runArtifacts.startEpoch,
                              endEpoch: runArtifacts.endEpoch,
                              logger,
                          })
                    : undefined,
                loadDeploymentHealth: async () =>
                    "Deployment health is not wired in investigation v1 (no cross-cluster k8s read configured) - infer service health from the run + app logs instead.",
                reasoningModel: session.getModel({ model: "classifier", tag: "investigation-classify" }),
                visionModel: session.getModel({ model: "smart-visual", tag: "investigation-vision" }),
                maxSteps: env.INVESTIGATION_CLASSIFY_MAX_STEPS,
            },
        );

        await persistInvestigationCosts(db, snapshotId, session.costCollector, logger);

        // The report features the frame the classifier judged most descriptive (verdict.keyStepIndex), not
        // mechanically the last/failed one. When it named no step we show no screenshot rather than falling back
        // to the run's final frame, which is often a setup/blank/home screen and reads as a misleading "failure".
        const keyScreenshot = resolveKeyScreenshot(generation.attempts, verdict.keyStepIndex);
        const clipUrl = await maybeGenerateClip(verdict.category, runArtifacts.video?.data, testGenerationId, logger);
        logger.info("Shadow run classified", {
            extra: { category: verdict.category, confidence: verdict.confidence, keyStepIndex: verdict.keyStepIndex },
        });
        return {
            slug,
            plan: generation.testPlan.prompt,
            runSuccess: runArtifacts.success,
            stepCount: runArtifacts.stepCount,
            runSteps: runArtifacts.steps,
            runTrace: deriveRunTrace(generation.attempts),
            verdict,
            videoUrl: generation.videoUrl ?? undefined,
            finalScreenshotUrl: keyScreenshot ?? undefined,
            clipUrl,
        };
    });
}

/**
 * For a confirmed client bug with a run recording, render a short GIF of the failure and upload it, so the
 * investigation PR comment can embed an inline clip. Best-effort and client-bug-only: any failure (no video,
 * ffmpeg error, upload error) returns undefined and the comment falls back to the key-frame screenshot, if the
 * classifier named one.
 */
async function maybeGenerateClip(
    category: string,
    video: Uint8Array | undefined,
    testGenerationId: string,
    logger: Logger,
): Promise<string | undefined> {
    if (category !== "client_bug" || video == null) return undefined;
    const gif = await webmToGif(video, logger);
    if (gif == null) return undefined;
    const key = `test-generation/${testGenerationId}/clip.gif`;
    try {
        return await getStorage().upload(key, gif, "image/gif");
    } catch (error) {
        logger.warn("Could not upload GIF clip", { extra: { key }, err: error });
        return undefined;
    }
}

/**
 * Resolve the classifier's chosen trace step to its stored screenshot key. keyStepIndex is the step's `order`
 * as shown in the trace (`N. [interaction] status`); match on that rather than array position so it holds even
 * if orders are not a contiguous 1..N. Prefer the after-frame (the settled state), fall back to the before-frame.
 */
function resolveKeyScreenshot(attempts: AttemptRow[], keyStepIndex: number | undefined): string | undefined {
    if (keyStepIndex == null) return undefined;
    const step = attempts.find((attempt) => attempt.order === keyStepIndex);
    if (step == null) return undefined;
    return step.screenshotAfter ?? step.screenshotBefore ?? undefined;
}

/**
 * Describe what the scenario "up" ACTUALLY did - the seeded refs, whether valid auth was returned, the
 * up-time, and any provisioning error - so the classifier reasons from the real result instead of guessing.
 * Previously this returned only the status, so `seeded` was always absent and the prompt rendered it as
 * "nothing provisioned" - causing the classifier to convict provisioning when auth+data were in fact present.
 */
function describeProvision(generation: GenerationRow): { status: string; detail: string; seeded?: string } {
    const instance = generation.scenarioInstance;
    if (instance == null) {
        return { status: "no_scenario", detail: "No scenario was bound to this run - no auth or data was seeded." };
    }

    const parts = [`Scenario instance status: ${instance.status}.`];
    parts.push(
        summarizeAuth(instance.auth) ??
            "No auth credentials were returned by the up - the run had no login to use (a scenario gap).",
    );
    const upSeconds = upDurationSeconds(instance);
    if (upSeconds != null) {
        parts.push(`Instance was up ~${upSeconds}s before teardown${upSeconds < 60 ? " (a very early bail)" : ""}.`);
    }
    const error = summarizeError(instance.lastError);
    if (error != null) parts.push(`Provisioning error recorded: ${error}`);

    return { status: instance.status, detail: parts.join(" "), seeded: summarizeRefs(instance.refs) };
}

/** Per-entity seeded counts (e.g. "User=4, Workspace=1, Transaction=6") - never dumps ids/values. */
function summarizeRefs(refs: PrismaJson.ScenarioRefs | null): string | undefined {
    if (!isRecord(refs)) return undefined;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(refs)) {
        if (Array.isArray(value)) parts.push(`${key}=${value.length}`);
        else if (value != null) parts.push(key);
    }
    return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Report that valid auth WAS returned (field names only - the secret values are never included). */
function summarizeAuth(auth: PrismaJson.ScenarioAuth | null): string | undefined {
    if (Array.isArray(auth)) {
        return auth.length > 0
            ? `Valid auth credentials WERE returned (${auth.length} login(s); values redacted).`
            : undefined;
    }
    if (!isRecord(auth)) return undefined;
    const fields = Object.keys(auth);
    return fields.length > 0
        ? `Valid auth credentials WERE returned (fields: ${fields.join(", ")}; values redacted).`
        : undefined;
}

/** A short message from the instance's lastError JSON, if any was recorded. */
function summarizeError(lastError: PrismaJson.ScenarioLastError | null): string | undefined {
    if (lastError == null) return undefined;
    if (isRecord(lastError) && typeof lastError["message"] === "string") return lastError["message"].slice(0, 200);
    return JSON.stringify(lastError).slice(0, 200);
}

function upDurationSeconds(instance: ScenarioInstanceRow): number | undefined {
    if (instance.upAt == null || instance.downAt == null) return undefined;
    return Math.round((instance.downAt.getTime() - instance.upAt.getTime()) / 1000);
}

/** Build the in-memory run artifacts: derive the step trace from the attempts, fetch media from S3. */
async function buildRunArtifacts(generation: GenerationRow): Promise<RunArtifacts> {
    const steps = deriveSteps(generation.attempts);
    const storage = getStorage();

    // Prefer the dead-time-stripped mp4 the vision model bills fewer frames for; fall back to the original webm.
    const videoKey = generation.optimizedVideoUrl ?? generation.videoUrl;
    const videoBytes = videoKey != null ? await downloadMedia(videoKey) : undefined;
    const video: RunVideo | undefined =
        videoBytes != null
            ? { data: videoBytes, mediaType: generation.optimizedVideoUrl != null ? "video/mp4" : "video/webm" }
            : undefined;
    const finalScreenshot =
        generation.finalScreenshot != null ? await downloadMedia(generation.finalScreenshot) : undefined;

    return {
        success: generation.status === "success",
        finishReason: generation.status,
        stepCount: steps.length,
        steps,
        reasoning: generation.reasoning ?? undefined,
        startEpoch: Math.floor(generation.createdAt.getTime() / 1000),
        endEpoch: Math.floor(generation.updatedAt.getTime() / 1000),
        video,
        finalScreenshot,
        stepScreenshots: [],
    };

    async function downloadMedia(urlOrKey: string): Promise<Uint8Array | undefined> {
        try {
            return new Uint8Array(await storage.download(urlOrKey));
        } catch (error) {
            rootLogger.warn("Could not download run media", { extra: { urlOrKey }, err: error });
            return undefined;
        }
    }
}

const MAX_TRACE_STEPS = 120;
const MAX_STEP_CHARS = 300;

/**
 * Build the step-by-step trace from the run's StepAttempt rows. Each line carries the step's interaction,
 * status, and - crucially - the engine's per-step error, so the classifier sees exactly which steps failed
 * and why (the conversation field doesn't hold this; that's why earlier runs showed stepCount 0).
 */
function deriveSteps(attempts: AttemptRow[]): string[] {
    return attempts.slice(0, MAX_TRACE_STEPS).map((attempt) => {
        const failure = attempt.error != null ? ` - ERROR: ${attempt.error.slice(0, MAX_STEP_CHARS)}` : "";
        return `${attempt.order}. [${attempt.interaction}] ${attempt.status}${failure}`;
    });
}

/**
 * Build the STRUCTURED trace: each step's frame (the s3 key, signed on read) plus any click/drag coordinates
 * from the command output, so the finding page can render an inspectable trace where a reviewer opens the
 * screenshot and sees exactly where the agent acted. Prefer the before-frame - it is the image the point
 * detector ran on, so the overlay marker lands in the right place; fall back to the after-frame.
 */
function deriveRunTrace(attempts: AttemptRow[]): InvestigationRunStep[] {
    return attempts.slice(0, MAX_TRACE_STEPS).map((attempt) => {
        const parsed = stepOutputDataSchema.safeParse(attempt.output);
        const output = parsed.success ? parsed.data : undefined;
        return {
            order: attempt.order,
            interaction: attempt.interaction,
            status: attempt.status,
            error: attempt.error != null ? attempt.error.slice(0, MAX_STEP_CHARS) : undefined,
            screenshotUrl: attempt.screenshotBefore ?? attempt.screenshotAfter ?? undefined,
            point: output?.point,
            startPoint: output?.startPoint,
            endPoint: output?.endPoint,
        };
    });
}

/**
 * Resolve the previewkit namespace for a PR - the Loki log-stream selector. `previewkit_environment` keys the
 * namespace on (repoFullName, prNumber); a preview that was never deployed or has been torn down returns
 * undefined and app-log querying degrades gracefully (prNumber 0 means resolvePrMeta found no feature branch).
 */
async function resolvePreviewNamespace(
    repoFullName: string,
    prNumber: number,
    logger: Logger,
): Promise<string | undefined> {
    if (prNumber === 0) return undefined;
    const previewEnv = await db.previewkitEnvironment.findUnique({
        where: { repoFullName_prNumber: { repoFullName, prNumber } },
        select: { namespace: true },
    });
    if (previewEnv == null) {
        logger.info("No previewkit environment for PR - app logs unavailable", {
            extra: { repoFullName, prNumber },
        });
        return undefined;
    }
    logger.info("Resolved preview namespace for app logs", { extra: { repoFullName, prNumber } });
    return previewEnv.namespace;
}
