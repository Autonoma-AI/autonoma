import { InlineMp4VideoUploader, type UploadedVideo, type VideoUploader } from "@autonoma/ai";
import { type ApplicationArchitecture, db } from "@autonoma/db";
import { readPrDiffStat, type InspectableStep, StorageEvidenceLoader } from "@autonoma/diffs";
import {
    ClassifierAgent,
    PreviewEnvironment,
    PriorRuns,
    type RunArtifacts,
    type RunFacts,
    loadPreviewAppLogs,
    persistInvestigationCosts,
    readPreviewConnectionKeys,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { getStepOverlayPoints, type InvestigationRunStep, stepOutputDataSchema } from "@autonoma/types";
import type { ClassifyInvestigationRunInput, InvestigationTestResult } from "@autonoma/workflow/activities";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { resolvePrMeta } from "../codebase/pr-meta";
import { withSnapshotContext } from "../codebase/snapshot-context";
import { env } from "../env";
import { webmToGif } from "../media/webm-to-gif";
import { previewSecrets } from "../preview-secrets";
import { createModelSession, getStorage } from "../services";
import { uploadConversation } from "../upload-conversation";
import { buildStepTrace } from "./step-trace";

/** The preview facts the classifier's backend tools need: where to read logs, and what the pod's env holds. */
interface ResolvedPreview {
    namespace: string;
    /** Env keys the topology wires in, which override the secret bundle on collision. */
    connectionKeys: string[];
}

/** How many of a run's step attempts reach the classifier at all. */
const MAX_TRACE_STEPS = 120;
/** Per-step error budget in the structured run trace the finding page renders. */
const MAX_STEP_CHARS = 300;

/** The columns {@link buildRunArtifacts} and {@link describeProvision} read off a generation. */
const GENERATION_SELECT = {
    status: true,
    videoUrl: true,
    optimizedVideoUrl: true,
    finalScreenshot: true,
    reasoning: true,
    createdAt: true,
    updatedAt: true,
    testPlan: { select: { prompt: true } },
    snapshot: { select: { branch: { select: { application: { select: { architecture: true } } } } } },
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
            params: true,
            output: true,
            createdAt: true,
        },
        orderBy: { order: "asc" },
    },
} as const;

type AttemptRow = {
    order: number;
    interaction: string;
    status: string;
    error: string | null;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
    params: object | null;
    output: object | null;
    createdAt: Date;
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

export type GenerationRow = {
    status: string;
    videoUrl: string | null;
    optimizedVideoUrl: string | null;
    finalScreenshot: string | null;
    reasoning: string | null;
    createdAt: Date;
    updatedAt: Date;
    testPlan: { prompt: string };
    snapshot: { branch: { application: { architecture: ApplicationArchitecture } } };
    scenarioInstance: ScenarioInstanceRow | null;
    attempts: AttemptRow[];
};

/**
 * Load the generation a classification reasons from, with the columns {@link buildRunArtifacts} and
 * {@link describeProvision} need.
 *
 * The one reader of {@link GENERATION_SELECT}, so freezing a replayable classification goes through this rather
 * than reaching for the raw select: the select stays private, and a captured case cannot drift from the columns
 * production classified.
 */
export function loadGenerationRow(generationId: string): Promise<GenerationRow> {
    return db.testGeneration.findUniqueOrThrow({ where: { id: generationId }, select: GENERATION_SELECT });
}

/**
 * Classify one shadow run: load its generation row + media, clone the codebase, wire the classifier's
 * dependencies against real infra (Prisma / S3 / preview secrets / the cloned repo / the models / Loki), and
 * run the classifier. get_app_logs is wired to the preview's Loki stream, when the namespace resolves from
 * the PR's previewkit environment and this worker has LOKI configured; otherwise the tool is omitted.
 */
export async function classifyInvestigationRun(input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult> {
    const { snapshotId, slug, reason, testGenerationId, priorPass } = input;
    const logger = rootLogger.child({
        name: "classifyInvestigationRun",
        extra: { snapshotId, slug, testGenerationId },
    });
    logger.info("Classifying shadow run");

    const generation = await loadGenerationRow(testGenerationId);

    return withSnapshotContext(snapshotId, `classify-${testGenerationId}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const resolvedPreview = await resolvePreviewEnvironment(context.repoFullName, prMeta.prNumber, logger);
        const session = createModelSession();
        const priorRuns = new PriorRuns(db);

        // getVideoModel rather than getModel: acquiring it IS the video-capability check, so a model whose entry
        // declares no uploader fails here rather than at the provider. The uploader itself is built with THIS
        // host's ffmpeg - the image ships none on PATH, and which binary exists is a fact the shared registry
        // cannot know - so the entry's own factory would silently fail to transcode a pre-optimizer webm.
        const recordingModel = session.getVideoModel({ model: "smart-video", tag: "investigation-vision-video" });
        const uploader = new InlineMp4VideoUploader(ffmpeg.path);
        const { run: runArtifacts, recordingBytes } = await buildRunArtifacts(generation, uploader);

        // Gate the previewkit-dependent tools on whether this PR's preview is actually managed by previewkit. The
        // namespace only resolves for a previewkit-deployed preview; when it does not (a self-hosted / non-integrated
        // client), there is no Loki stream and the backend script harness cannot authenticate - so we omit
        // get_app_logs / run_script / get_preview_env rather than let them fail with confusing errors the classifier
        // mistakes for signal. App logs additionally need LOKI configured on this worker.
        const previewIntegrated = resolvedPreview != null;
        // Bind the two values the log loader REQUIRES, rather than a boolean: it now throws instead of
        // returning prose, so it must never be constructed without an endpoint and a namespace to reach.
        const lokiUrl = env.LOKI_URL != null && env.LOKI_URL !== "" ? env.LOKI_URL : undefined;
        const loadAppLogs =
            resolvedPreview != null && lokiUrl != null
                ? (regex: string) =>
                      loadPreviewAppLogs({
                          regex,
                          lokiUrl,
                          namespace: resolvedPreview.namespace,
                          startEpoch: runArtifacts.startEpoch,
                          endEpoch: runArtifacts.endEpoch,
                          logger,
                      })
                : undefined;
        const preview = previewIntegrated
            ? new PreviewEnvironment(previewSecrets(), context.applicationId, resolvedPreview.connectionKeys)
            : undefined;
        logger.info("Resolved preview introspection availability", {
            extra: { previewIntegrated, appLogsAvailable: loadAppLogs != null },
        });

        const classifier = new ClassifierAgent({
            model: session.getModel({ model: "classifier", tag: "investigation-classify" }),
            videoModel: recordingModel.model,
        });
        const { result: verdict, conversation } = await classifier.run({
            appSlug: context.appSlug,
            prNumber: prMeta.prNumber,
            test: { slug, plan: generation.testPlan.prompt, affectedReason: reason },
            provision: describeProvision(generation),
            diffSummary: await readPrDiffStat({
                root: context.codebase.root,
                baseSha: context.baseSha,
                headSha: context.headSha,
            }),
            prTitle: prMeta.prTitle,
            prBody: prMeta.prBody,
            priorPass,
            codebase: context.codebase,
            baseSha: context.baseSha,
            headSha: context.headSha,
            run: runArtifacts,
            screenshotLoader: new StorageEvidenceLoader(getStorage()),
            // One instance in both slots - it satisfies each capability, so both tools are registered.
            previewEnv: preview,
            previewScript: preview,
            loadBaseline: async () => PriorRuns.formatBaseline(await priorRuns.getHistory(context.applicationId, slug)),
            loadAppLogs,
        });

        // Persist the classifier's reasoning (best-effort) so a wrong verdict can be debugged, alongside the cost
        // ledger - both are independent auxiliary writes and a failure of either must not sink the classification.
        const [conversationUrl] = await Promise.all([
            uploadConversation({
                storage: getStorage(),
                snapshotId,
                phase: "classify",
                generationId: testGenerationId,
                conversation,
                logger: logger.child({ name: "uploadConversation" }),
            }),
            persistInvestigationCosts(db, snapshotId, session.costCollector, logger),
        ]);

        // The report features the frame the classifier judged most descriptive (verdict.keyStepIndex), not
        // mechanically the last/failed one. When it named no step we show no screenshot rather than falling back
        // to the run's final frame, which is often a setup/blank/home screen and reads as a misleading "failure".
        const keyScreenshot = resolveKeyScreenshot(generation.attempts, verdict.keyStepIndex);
        const clipUrl = await maybeGenerateClip(verdict.category, recordingBytes, testGenerationId, logger);
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
            optimizedVideoUrl: generation.optimizedVideoUrl ?? undefined,
            keyScreenshotUrl: keyScreenshot ?? undefined,
            clipUrl,
            conversationUrl,
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
export function describeProvision(generation: GenerationRow): { status: string; detail: string; seeded?: string } {
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

/**
 * The run's artifacts, plus the recording's raw bytes.
 *
 * The bytes are returned alongside rather than carried on {@link RunArtifacts} because they exist for a
 * non-model purpose - rendering the failure GIF - while the model path takes the uploaded form only.
 */
export interface BuiltRunArtifacts {
    run: RunArtifacts;
    recordingBytes?: Uint8Array;
}

/**
 * Derive the run's facts from the generation row - no I/O. Separate from the media fetch below so freezing a
 * replayable case does not download and transcode a recording it drops.
 */
export function buildRunFacts(generation: GenerationRow): RunFacts {
    const traced = generation.attempts.slice(0, MAX_TRACE_STEPS);
    const steps = buildStepTrace(traced, generation.createdAt);

    return {
        success: generation.status === "success",
        finishReason: generation.status,
        stepCount: steps.length,
        steps,
        reasoning: generation.reasoning ?? undefined,
        startEpoch: Math.floor(generation.createdAt.getTime() / 1000),
        endEpoch: Math.floor(generation.updatedAt.getTime() / 1000),
        inspectableSteps: deriveInspectableSteps(traced),
        architecture: generation.snapshot.branch.application.architecture,
    };
}

export async function buildRunArtifacts(
    generation: GenerationRow,
    uploader: VideoUploader,
): Promise<BuiltRunArtifacts> {
    const storage = getStorage();

    // Prefer the dead-time-stripped mp4 the vision model bills fewer frames for; fall back to the original webm.
    const videoKey = generation.optimizedVideoUrl ?? generation.videoUrl;
    // Two independent reads against the same bucket: fetched together so neither pays the other's latency.
    // The upload has to wait for its own bytes, so it stays sequential behind them.
    const [recordingBytes, finalScreenshot] = await Promise.all([
        videoKey != null ? downloadMedia(videoKey) : undefined,
        generation.finalScreenshot != null ? downloadMedia(generation.finalScreenshot) : undefined,
    ]);
    const recording =
        recordingBytes != null
            ? await uploadRecording(recordingBytes, generation.optimizedVideoUrl != null, uploader)
            : undefined;

    const run: RunArtifacts = { ...buildRunFacts(generation), recording, finalScreenshot };
    return { run, recordingBytes };

    async function downloadMedia(urlOrKey: string): Promise<Uint8Array | undefined> {
        try {
            return new Uint8Array(await storage.download(urlOrKey));
        } catch (error) {
            rootLogger.warn("Could not download run media", { extra: { urlOrKey }, err: error });
            return undefined;
        }
    }
}

/**
 * Hand the classifier the recording in whatever form its vision models take, via the uploader the model's
 * registry entry declares - so this never has to know that the OpenRouter-routed models want inline base64 mp4
 * and a Google one wants a Files-API URI. The optimizer's output is already mp4; a pre-optimizer run is webm,
 * which the uploader transcodes.
 *
 * A failed upload drops the recording rather than the run: the probes and `analyze_video` degrade to their own
 * "no recording" notes, which beats failing a classification over a video.
 */
async function uploadRecording(
    bytes: Uint8Array,
    isOptimizedMp4: boolean,
    uploader: VideoUploader,
): Promise<UploadedVideo | undefined> {
    const logger = rootLogger.child({ name: "uploadRecording" });
    try {
        return await uploader.uploadVideo({
            data: { type: "buffer", buffer: Buffer.from(bytes).buffer },
            mimeType: isOptimizedMp4 ? "video/mp4" : "video/webm",
        });
    } catch (error) {
        logger.warn("Could not prepare the recording for the vision models; classifying without it", {
            extra: { bytes: bytes.length },
            err: error,
        });
        return undefined;
    }
}

/**
 * What `view_step_details` discloses when the model drills into a step: the frame KEYS plus the engine's own
 * record of the step, untouched.
 *
 * Keyed by the attempt's `order` - the number the trace line renders - NOT by array position, which would
 * silently resolve to the wrong step whenever orders are not a contiguous 1..N. Keys rather than bytes: a run
 * has up to 120 steps and a classification drills into two or three.
 *
 * Every traced step appears, including one that captured no frame: the tool discloses the step's params,
 * output and error too, so a frameless step still has something to answer with. That also keeps the set the
 * tool offers identical to the set the trace lists.
 */
function deriveInspectableSteps(attempts: AttemptRow[]): InspectableStep[] {
    return attempts.map((attempt) => {
        // The same points the finding page draws, from the one shared extractor - so the marker the classifier
        // sees on a before-frame is in the same place a human later sees it on the report.
        const overlayPoints = getStepOverlayPoints(attempt.output);
        return {
            order: attempt.order,
            screenshotBeforeKey: attempt.screenshotBefore ?? undefined,
            screenshotAfterKey: attempt.screenshotAfter ?? undefined,
            overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
            interaction: attempt.interaction,
            status: attempt.status,
            params: attempt.params ?? undefined,
            output: attempt.output ?? undefined,
            error: attempt.error ?? undefined,
        };
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
async function resolvePreviewEnvironment(
    repoFullName: string,
    prNumber: number,
    logger: Logger,
): Promise<ResolvedPreview | undefined> {
    if (prNumber === 0) return undefined;
    const previewEnv = await db.previewkitEnvironment.findUnique({
        where: { repoFullName_prNumber: { repoFullName, prNumber } },
        select: { namespace: true, resolvedConfig: true },
    });
    if (previewEnv == null) {
        logger.info("No previewkit environment for PR - app logs unavailable", {
            extra: { repoFullName, prNumber },
        });
        return undefined;
    }
    // An unreadable config yields no keys: the classifier then sees the secret bundle alone, so the gap narrows
    // what it is told rather than misleading it. A capture makes the opposite call on the same signal and
    // freezes nothing, because a case's name list has to stand on its own long after the config is gone.
    const connectionKeys = readPreviewConnectionKeys(previewEnv.resolvedConfig, logger) ?? [];
    logger.info("Resolved preview environment", {
        extra: { repoFullName, prNumber, connectionKeys: connectionKeys.length },
    });
    return { namespace: previewEnv.namespace, connectionKeys };
}
