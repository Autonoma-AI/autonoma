import type { PrismaClient } from "@autonoma/db";
import {
    type ChangeContext,
    type GenerationContext,
    type GenerationStepData,
    resolveScenarioDataForGeneration,
} from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { getStepOverlayPoints } from "@autonoma/types";
import type { ModelMessage } from "ai";

/** One `StepAttempt` row, the preferred source for generation steps. */
interface GenerationAttemptRow {
    order: number;
    interaction: string;
    params: unknown;
    status: "success" | "failed";
    output: unknown;
    error: string | null;
    errorName: string | null;
    screenshotBefore: string | null;
    screenshotAfter: string | null;
}

/**
 * Gathers everything the generation reviewer needs for a single generation from the
 * database: the executed steps + test metadata, the snapshot's diff anchor, and the
 * materialized scenario data.
 *
 * This is the only piece of the diff-job path with DB access. It performs no git
 * or filesystem work - the agent derives the changed files and diff hunks itself
 * via `git diff` against the checked-out tree - which keeps the agent run
 * DB-free and the loader trivially testable against a real Postgres.
 *
 * Multimedia (step screenshots + video) stays referenced by S3 key only; an
 * `EvidenceLoader` rehydrates the bytes at run time. The generation conversation
 * is the one exception: it is text the reviewer inlines into the prompt (and
 * that the eval fixture freezes), so the loader resolves it eagerly from S3 here.
 */
export class DiffJobContextLoader {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly storage: StorageProvider,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Gather everything the generation reviewer needs for a single generation:
     * the executed steps, the agent conversation (downloaded from S3), and the
     * snapshot's diff anchor. The generation reviewer already reasons over the
     * conversation; the change context widens it with the diff under review.
     *
     * Steps come from the `StepAttempt` timeline - every attempt in true order,
     * counting failures - so the Step Summary surfaces failed attempts (the most
     * diagnostic moments) the successful-only `StepInput` list omits. Each
     * attempt maps to the normalized reviewer step shape: `output` on success,
     * `error` + `errorName` on failure. Generations that predate the `StepAttempt`
     * table have no attempts; for those (and re-captures of them) the loader falls
     * back to the `StepInput` list, mapping each step as a success.
     */
    async loadGeneration(generationId: string): Promise<GenerationContext> {
        this.logger.info("Loading generation review context", { generationId });

        const generation = await this.db.testGeneration.findUniqueOrThrow({
            where: { id: generationId },
            select: {
                id: true,
                status: true,
                reasoning: true,
                videoUrl: true,
                optimizedVideoUrl: true,
                finalScreenshot: true,
                conversationUrl: true,
                organizationId: true,
                testPlan: {
                    select: {
                        prompt: true,
                        testCaseId: true,
                        testCase: { select: { name: true, description: true } },
                    },
                },
                snapshot: {
                    select: {
                        headSha: true,
                        baseSha: true,
                        branch: { select: { application: { select: { architecture: true } } } },
                    },
                },
                // The full attempt timeline (successes and failures), in true
                // order, with the per-attempt diagnostic fields.
                attempts: {
                    select: {
                        order: true,
                        interaction: true,
                        params: true,
                        status: true,
                        output: true,
                        error: true,
                        errorName: true,
                        screenshotBefore: true,
                        screenshotAfter: true,
                    },
                    orderBy: { order: "asc" },
                },
            },
        });

        const steps = this.resolveGenerationSteps(generation.attempts);

        const conversation = await this.loadConversation(generation.conversationUrl);
        const change = this.buildChangeContext(generationId, generation.snapshot);

        // Resolved + materialized via the shared, agent-agnostic helper so the
        // loader stays DB-only. Returns undefined (and we omit it) when the
        // generation has no scenario, UP never succeeded, or the graph is empty.
        const scenario = await resolveScenarioDataForGeneration(this.db, generationId);

        this.logger.info("Generation review context loaded", {
            generationId,
            stepCount: steps.length,
            selfReportedStatus: generation.status,
            hasChange: change != null,
            hasScenario: scenario != null,
        });

        return {
            generationId: generation.id,
            organizationId: generation.organizationId,
            selfReportedStatus: generation.status,
            testCaseName: generation.testPlan.testCase.name,
            testCaseDescription: generation.testPlan.testCase.description ?? undefined,
            testPlanPrompt: generation.testPlan.prompt,
            conversation,
            steps,
            architecture: generation.snapshot.branch.application.architecture,
            reasoning: generation.reasoning ?? undefined,
            videoUrl: generation.videoUrl ?? undefined,
            optimizedVideoUrl: generation.optimizedVideoUrl ?? undefined,
            finalScreenshotKey: generation.finalScreenshot ?? undefined,
            change,
            scenario,
        };
    }

    /**
     * Map a generation's `StepAttempt` timeline (failures included) to the
     * normalized reviewer step shape.
     */
    private resolveGenerationSteps(attempts: readonly GenerationAttemptRow[]): GenerationStepData[] {
        return attempts.map((attempt) => {
            const overlayPoints = getStepOverlayPoints(attempt.output);
            return {
                order: attempt.order,
                interaction: attempt.interaction,
                params: attempt.params,
                status: attempt.status,
                output: attempt.output ?? undefined,
                error: attempt.error ?? undefined,
                errorName: attempt.errorName ?? undefined,
                screenshotBeforeKey: attempt.screenshotBefore ?? undefined,
                screenshotAfterKey: attempt.screenshotAfter ?? undefined,
                overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
            };
        });
    }

    private async loadConversation(conversationUrl: string | null): Promise<ModelMessage[]> {
        if (conversationUrl == null) {
            this.logger.warn("No conversation URL found - returning empty conversation");
            return [];
        }
        this.logger.info("Downloading execution conversation", { conversationUrl });
        const buffer = await this.storage.download(conversationUrl);
        const parsed: unknown = JSON.parse(buffer.toString("utf-8"));
        if (!Array.isArray(parsed)) {
            this.logger.warn("Downloaded conversation is not an array - returning empty conversation", {
                conversationUrl,
            });
            return [];
        }
        return parsed;
    }

    /**
     * Assemble the subject-scoped change facts. Returns `undefined` when the
     * snapshot is missing its SHAs - without them the reviewer has nothing to
     * `git diff` against, so the change section would be useless.
     */
    private buildChangeContext(
        subjectId: string,
        snapshot: { headSha: string | null; baseSha: string | null },
    ): ChangeContext | undefined {
        if (snapshot.baseSha == null || snapshot.headSha == null) {
            this.logger.warn("Snapshot is missing base/head SHA - omitting change context from review", {
                subjectId,
            });
            return undefined;
        }

        return { baseSha: snapshot.baseSha, headSha: snapshot.headSha };
    }
}
