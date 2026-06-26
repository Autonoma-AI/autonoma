import { db } from "@autonoma/db";
import {
    LocalCodebaseReader,
    PreviewEnvironment,
    PreviewSecrets,
    PriorRuns,
    type RunArtifacts,
    classifyRun,
} from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { ClassifyInvestigationRunInput, InvestigationTestResult } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { withSnapshotContext } from "../codebase/resolve";
import { env } from "../env";
import { createModelSession, getStorage } from "../services";

type AttemptRow = { order: number; interaction: string; status: string; error: string | null };

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
 * dependencies against real infra (Prisma / S3 / preview secrets / the cloned repo / the models), and run
 * the classifier. NOTE: get_app_logs (Loki) + get_deployment_health (k8s) are not wired in v1 - they return
 * a clear "unavailable" note and the classifier degrades gracefully; the high-value tools are all wired.
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
            finalScreenshot: true,
            reasoning: true,
            createdAt: true,
            updatedAt: true,
            testPlan: { select: { prompt: true } },
            scenarioInstance: {
                select: { status: true, auth: true, refs: true, lastError: true, upAt: true, downAt: true },
            },
            attempts: {
                select: { order: true, interaction: true, status: true, error: true },
                orderBy: { order: "asc" },
            },
        },
    });

    const runArtifacts = await buildRunArtifacts(generation);

    return withSnapshotContext(snapshotId, `classify-${testGenerationId}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const preview = new PreviewEnvironment(PreviewSecrets.create(), context.repoFullName);
        const session = createModelSession();
        const priorRuns = new PriorRuns(db);

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
                loadAppLogs: async () =>
                    "App logs are not wired in investigation v1 (no preview Loki namespace resolution yet) - classify from the run, code, and queried data instead.",
                loadDeploymentHealth: async () =>
                    "Deployment health is not wired in investigation v1 (no cross-cluster k8s read configured) - infer service health from the run + app logs instead.",
                reasoningModel: session.getModel({ model: "classifier", tag: "investigation-classify" }),
                visionModel: session.getModel({ model: "smart-visual", tag: "investigation-vision" }),
                maxSteps: env.INVESTIGATION_CLASSIFY_MAX_STEPS,
            },
        );

        logger.info("Shadow run classified", { extra: { category: verdict.category, confidence: verdict.confidence } });
        return {
            slug,
            plan: generation.testPlan.prompt,
            runSuccess: runArtifacts.success,
            stepCount: runArtifacts.stepCount,
            verdict,
            videoUrl: generation.videoUrl ?? undefined,
            finalScreenshotUrl: generation.finalScreenshot ?? undefined,
        };
    });
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

    const video = generation.videoUrl != null ? await downloadMedia(generation.videoUrl) : undefined;
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
