import { readFile } from "node:fs/promises";
import type { CostRecord } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";
import type { CommandSpec } from "../../commands";
import { videoContentType } from "../../platform/video-content-type";
import type { FailedStep, GeneratedStep } from "../agent";
import type { HeadlessRunResult } from "../runner";
import type { AttemptData } from "../runner/events";

/** The result of persisting a generation. */
export interface PersistedGeneration {
    generationId: string;
    stepInputListId: string;
    stepOutputListId: string;
}

export interface GenerationPersisterConfig {
    /** The database client */
    db: PrismaClient;
    /** The storage provider */
    storageProvider: StorageProvider;
    /** The test generation ID */
    testGenerationId: string;
    /** The video extension */
    videoExtension: string;
}

export type PlanData = Awaited<ReturnType<(typeof GenerationPersister.prototype)["markRunning"]>>;

export class GenerationPersister<TSpec extends CommandSpec> {
    private readonly logger: Logger;

    private organizationId?: string;
    private testPlanId?: string;
    private testCaseId?: string;
    private snapshotId?: string;
    private stepInputListId?: string;
    private stepOutputListId?: string;

    constructor(private readonly config: GenerationPersisterConfig) {
        this.logger = logger.child({ name: "GenerationPersister", testGenerationId: this.id });
    }

    private get id() {
        return this.config.testGenerationId;
    }

    private get db() {
        return this.config.db;
    }

    /**
     * Marks the generation as running, creates StepInputList + StepOutputList,
     * and returns the test plan and application.
     */
    public async markRunning() {
        const generation = await this.db.testGeneration.update({
            where: { id: this.id },
            data: { status: "running" },
            select: {
                testPlan: {
                    select: {
                        id: true,
                        prompt: true,
                        testCase: {
                            select: {
                                id: true,
                                name: true,
                                application: { select: { name: true, architecture: true, customInstructions: true } },
                            },
                        },
                    },
                },
                snapshot: {
                    select: {
                        branch: {
                            select: {
                                deployment: {
                                    include: {
                                        webDeployment: true,
                                        mobileDeployment: true,
                                    },
                                },
                            },
                        },
                    },
                },
                scenarioInstance: { select: { auth: true, resolvedVariables: true } },
                snapshotId: true,
                organizationId: true,
            },
        });

        this.organizationId = generation.organizationId;
        this.testPlanId = generation.testPlan.id;
        this.testCaseId = generation.testPlan.testCase.id;
        this.snapshotId = generation.snapshotId;

        const stepInputList = await this.db.stepInputList.create({
            data: { planId: generation.testPlan.id, organizationId: this.organizationId },
            select: { id: true },
        });
        this.stepInputListId = stepInputList.id;

        const stepOutputList = await this.db.stepOutputList.create({
            data: { organizationId: this.organizationId },
            select: { id: true },
        });
        this.stepOutputListId = stepOutputList.id;

        await this.db.testGeneration.update({
            where: { id: this.id },
            data: {
                stepsId: stepInputList.id,
                outputsId: stepOutputList.id,
            },
        });

        return generation;
    }

    /**
     * Marks the generation as failed with an `engine_error` system failure.
     *
     * @param error - The caught error; its message is unwrapped and stored as the
     *   `engine_error` failure message and rendered in the critical failure panel.
     */
    public async markFailed(error: unknown) {
        // A thrown exception inside the engine (driver/engine crash) - classify it as a
        // system `engine_error` so it renders in the critical failure panel with the real
        // message, instead of polluting `reasoning` (which is reserved for AI test outcomes).
        const message = error instanceof Error ? error.message : "Unknown error";
        this.logger.info("Marking generation as failed", { extra: { message } });
        await this.db.testGeneration.update({
            where: { id: this.id },
            data: {
                status: "failed",
                failure: { kind: "engine_error", message },
            },
        });
    }

    /**
     * Upload the conversation to S3 and store the URL in the database.
     */
    public async uploadConversation(conversation: ModelMessage[]) {
        this.logger.info("Uploading conversation to S3");

        const conversationBuffer = Buffer.from(JSON.stringify(conversation));
        const conversationUrl = await this.config.storageProvider.upload(
            this.conversationKey(this.id),
            conversationBuffer,
        );

        await this.db.testGeneration.update({
            where: { id: this.id },
            data: { conversationUrl },
        });

        this.logger.info("Conversation uploaded to S3", { conversationUrl });
    }

    /**
     * Live-persist a single command attempt as it happens.
     *
     * Successes write a `StepAttempt(success)` plus the committed step rows
     * (`StepInput` + `StepOutput`), reusing the StepInput screenshot keys.
     * Failures write only a `StepAttempt(failed)` under a separate screenshot
     * namespace so they cannot collide with the order-keyed StepInput screenshots.
     */
    public async recordAttempt({ attempt, order, successfulOrder }: AttemptData<TSpec>) {
        if (attempt.status === "success") {
            if (successfulOrder == null) {
                throw new Error("Successful attempt is missing its successful-step order");
            }
            await this.recordSuccessfulAttempt(attempt, order, successfulOrder);
            return;
        }

        await this.recordFailedAttempt(attempt, order);
    }

    /**
     * Persist a successful attempt: the `StepInput` + `StepOutput` committed step
     * rows and a `StepAttempt(success)` that reuses the same screenshot keys (no re-upload).
     */
    private async recordSuccessfulAttempt(step: GeneratedStep<TSpec>, order: number, successfulOrder: number) {
        const stepData = step.executionOutput.stepData;
        this.logger.info("Persisting successful attempt", {
            interaction: stepData.interaction,
            order,
            successfulOrder,
        });

        if (this.stepInputListId == null || this.stepOutputListId == null || this.organizationId == null) {
            throw new Error("Step lists not initialized - call markRunning() first");
        }

        let screenshotBeforeUrl: string | undefined = undefined;
        let screenshotAfterUrl: string | undefined = undefined;
        try {
            [screenshotBeforeUrl, screenshotAfterUrl] = await Promise.all([
                this.config.storageProvider.upload(
                    this.screenshotKey(this.id, successfulOrder, "before"),
                    step.beforeMetadata.screenshot.buffer,
                ),
                this.config.storageProvider.upload(
                    this.screenshotKey(this.id, successfulOrder, "after"),
                    step.afterMetadata.screenshot.buffer,
                ),
            ]);
        } catch (error) {
            this.logger.fatal("Failed to upload screenshots", error);
            throw error;
        }

        const stepInput = await this.db.stepInput.create({
            data: {
                listId: this.stepInputListId,
                organizationId: this.organizationId,
                order: successfulOrder,
                interaction: stepData.interaction,
                params: stripNullBytes(stepData.params),
                screenshotBefore: screenshotBeforeUrl,
                screenshotAfter: screenshotAfterUrl,
            },
            select: { id: true },
        });

        await this.db.stepOutput.create({
            data: {
                listId: this.stepOutputListId,
                organizationId: this.organizationId,
                order: successfulOrder,
                output: stripNullBytes(step.executionOutput.result),
                stepInputId: stepInput.id,
                screenshotBefore: screenshotBeforeUrl,
                screenshotAfter: screenshotAfterUrl,
            },
            select: { id: true },
        });

        // Reuse the StepInput screenshot keys - no second upload.
        await this.db.stepAttempt.create({
            data: {
                generationId: this.id,
                organizationId: this.organizationId,
                order,
                interaction: stepData.interaction,
                params: stripNullBytes(stepData.params),
                status: "success",
                output: stripNullBytes(step.executionOutput.result),
                screenshotBefore: screenshotBeforeUrl,
                screenshotAfter: screenshotAfterUrl,
            },
            select: { id: true },
        });

        this.logger.info("Successful attempt persisted", { stepInputId: stepInput.id, order, successfulOrder });
    }

    /**
     * Persist a failed attempt: only a `StepAttempt(failed)` row. Screenshots go
     * under the attempt namespace, keyed by full-timeline order. The after-screenshot
     * is best-effort and may be absent.
     */
    private async recordFailedAttempt(attempt: FailedStep<TSpec>, order: number) {
        this.logger.info("Persisting failed attempt", {
            interaction: attempt.interaction,
            order,
            errorName: attempt.errorName,
        });

        if (this.organizationId == null) {
            throw new Error("Step lists not initialized - call markRunning() first");
        }

        let screenshotBeforeUrl: string | undefined = undefined;
        let screenshotAfterUrl: string | undefined = undefined;
        try {
            screenshotBeforeUrl = await this.config.storageProvider.upload(
                this.attemptScreenshotKey(this.id, order, "before"),
                attempt.beforeMetadata.screenshot.buffer,
            );
            if (attempt.afterMetadata != null) {
                screenshotAfterUrl = await this.config.storageProvider.upload(
                    this.attemptScreenshotKey(this.id, order, "after"),
                    attempt.afterMetadata.screenshot.buffer,
                );
            }
        } catch (error) {
            this.logger.fatal("Failed to upload failed-attempt screenshots", error);
            throw error;
        }

        await this.db.stepAttempt.create({
            data: {
                generationId: this.id,
                organizationId: this.organizationId,
                order,
                interaction: attempt.interaction,
                params: attempt.params != null ? stripNullBytes(attempt.params) : undefined,
                status: "failed",
                error: attempt.error,
                errorName: attempt.errorName,
                screenshotBefore: screenshotBeforeUrl,
                screenshotAfter: screenshotAfterUrl,
            },
            select: { id: true },
        });

        this.logger.info("Failed attempt persisted", { order, errorName: attempt.errorName });
    }

    /**
     * Mark the generation as completed.
     */
    public async markCompleted({ result, videoPath }: HeadlessRunResult<TSpec>) {
        this.logger.info("Recording test generation status", {
            status: result.success ? "success" : "failed",
        });

        let finalScreenshotUrl: string | undefined = undefined;
        if (result.finalScreenshot != null) {
            finalScreenshotUrl = await this.config.storageProvider.upload(
                this.finalScreenshotKey(this.id),
                result.finalScreenshot.buffer,
            );
        }

        // The agent ran to completion but did not pass. Classify the verdict via
        // finishReason: "max_steps" means it hit the step ceiling, anything else
        // ("error") means it gave up. These carry no message - the agent prose stays
        // in `reasoning`, and they render via the agent UI, not the SystemFailurePanel.
        const failure: PrismaJson.GenerationFailure | undefined = result.success
            ? undefined
            : result.finishReason === "max_steps"
              ? { kind: "max_steps" }
              : { kind: "agent_failed" };

        if (failure != null) {
            this.logger.info("Recording generation failure verdict", { extra: { failureKind: failure.kind } });
        }

        await this.db.testGeneration.update({
            where: { id: this.id },
            data: {
                status: result.success ? "success" : "failed",
                reasoning: result.reasoning,
                failure,
                finalScreenshot: finalScreenshotUrl,
                memory: result.memory,
            },
        });

        this.logger.info("Uploading video", { videoPath });
        const videoBuffer = await readFile(videoPath);
        const videoUrl = await this.config.storageProvider.upload(
            this.videoKey(this.id),
            videoBuffer,
            videoContentType(this.config.videoExtension),
        );

        this.logger.info("Saving video URL to database");
        await this.db.testGeneration.update({
            where: { id: this.id },
            data: { videoUrl },
        });

        if (result.success && this.testCaseId != null && this.snapshotId != null) {
            this.logger.info("Upserting test case assignment", {
                testCaseId: this.testCaseId,
                snapshotId: this.snapshotId,
            });
            await this.db.testCaseAssignment.upsert({
                where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId: this.testCaseId } },
                create: {
                    snapshotId: this.snapshotId,
                    testCaseId: this.testCaseId,
                    planId: this.testPlanId,
                },
                update: {
                    planId: this.testPlanId,
                },
            });
        }
    }

    /**
     * Save AI cost records for this generation.
     */
    public async saveCostRecords(records: readonly CostRecord[]) {
        if (records.length === 0) return;

        this.logger.info("Saving AI cost records", { count: records.length });

        await this.db.aiCostRecord.createMany({
            data: records.map((record) => ({
                generationId: this.id,
                model: record.model,
                tag: record.tag,
                inputTokens: record.inputTokens,
                outputTokens: record.outputTokens,
                reasoningTokens: record.reasoningTokens,
                cacheReadTokens: record.cacheReadTokens,
                costMicrodollars: record.costMicrodollars,
            })),
        });

        this.logger.info("AI cost records saved");
    }

    private screenshotKey(testGenerationId: string, order: number, phase: "before" | "after") {
        return `test-generation/${testGenerationId}/step-${order}-${phase}.png`;
    }

    private attemptScreenshotKey(testGenerationId: string, order: number, phase: "before" | "after") {
        return `test-generation/${testGenerationId}/attempt-${order}-${phase}.png`;
    }

    private finalScreenshotKey(testGenerationId: string) {
        return `test-generation/${testGenerationId}/final-screenshot.png`;
    }

    private conversationKey(testGenerationId: string) {
        return `test-generation/${testGenerationId}/conversation.json`;
    }

    private videoKey(testGenerationId: string) {
        return `test-generation/${testGenerationId}/video.${this.config.videoExtension}`;
    }
}

function stripNullBytes<T>(value: T): T {
    return JSON.parse(JSON.stringify(value).replaceAll("\\u0000", "")) as T;
}
