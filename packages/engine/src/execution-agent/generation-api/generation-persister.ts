import { readFile } from "node:fs/promises";
import type { CostRecord } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";
import type { CommandSpec } from "../../commands";
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
     * Marks the generation as failed.
     *
     * @param reason - Optional human-readable reason for the failure, stored in
     *   the `reasoning` field and displayed in the UI.
     */
    public async markFailed(reason?: string) {
        await this.db.testGeneration.update({
            where: { id: this.id },
            data: {
                status: "failed",
                ...(reason != null ? { reasoning: reason } : {}),
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
     * Successes write a `StepAttempt(success)` plus the replay rows
     * (`StepInput` + `StepOutput`), reusing the StepInput screenshot keys.
     * Failures write only a `StepAttempt(failed)` under a separate screenshot
     * namespace so they cannot collide with the order-keyed StepInput screenshots.
     */
    public async recordAttempt({ attempt, order, replayOrder }: AttemptData<TSpec>) {
        if (attempt.status === "success") {
            if (replayOrder == null) {
                throw new Error("Successful attempt is missing its replay order");
            }
            await this.recordSuccessfulAttempt(attempt, order, replayOrder);
            return;
        }

        await this.recordFailedAttempt(attempt, order);
    }

    /**
     * Persist a successful attempt: the `StepInput` + `StepOutput` replay rows and
     * a `StepAttempt(success)` that reuses the same screenshot keys (no re-upload).
     */
    private async recordSuccessfulAttempt(step: GeneratedStep<TSpec>, order: number, replayOrder: number) {
        const stepData = step.executionOutput.stepData;
        this.logger.info("Persisting successful attempt", { interaction: stepData.interaction, order, replayOrder });

        if (this.stepInputListId == null || this.stepOutputListId == null || this.organizationId == null) {
            throw new Error("Step lists not initialized - call markRunning() first");
        }

        let screenshotBeforeUrl: string | undefined = undefined;
        let screenshotAfterUrl: string | undefined = undefined;
        try {
            [screenshotBeforeUrl, screenshotAfterUrl] = await Promise.all([
                this.config.storageProvider.upload(
                    this.screenshotKey(this.id, replayOrder, "before"),
                    step.beforeMetadata.screenshot.buffer,
                ),
                this.config.storageProvider.upload(
                    this.screenshotKey(this.id, replayOrder, "after"),
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
                order: replayOrder,
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
                order: replayOrder,
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

        this.logger.info("Successful attempt persisted", { stepInputId: stepInput.id, order, replayOrder });
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

        await this.db.testGeneration.update({
            where: { id: this.id },
            data: {
                status: result.success ? "success" : "failed",
                reasoning: result.reasoning,
                finalScreenshot: finalScreenshotUrl,
                memory: result.memory,
            },
        });

        if (this.stepInputListId != null) {
            this.logger.info("Recording step wait conditions");
            const listId = this.stepInputListId;

            await Promise.all(
                result.generatedSteps.map(async (step, index) => {
                    const order = index + 1;
                    const waitCondition = step.waitCondition;

                    this.logger.info("Saving wait condition for step", { order, waitCondition });

                    await this.db.stepInput.update({
                        where: { listId_order: { listId, order } },
                        data: { waitCondition },
                    });
                }),
            );
        }

        this.logger.info("Uploading video", { videoPath });
        const videoBuffer = await readFile(videoPath);
        const videoUrl = await this.config.storageProvider.upload(this.videoKey(this.id), videoBuffer);

        this.logger.info("Saving video URL to database");
        await this.db.testGeneration.update({
            where: { id: this.id },
            data: { videoUrl },
        });

        if (result.success && this.stepInputListId != null && this.testCaseId != null && this.snapshotId != null) {
            this.logger.info("Upserting test case assignment with steps", {
                testCaseId: this.testCaseId,
                snapshotId: this.snapshotId,
            });
            await this.db.testCaseAssignment.upsert({
                where: { snapshotId_testCaseId: { snapshotId: this.snapshotId, testCaseId: this.testCaseId } },
                create: {
                    snapshotId: this.snapshotId,
                    testCaseId: this.testCaseId,
                    planId: this.testPlanId,
                    stepsId: this.stepInputListId,
                },
                update: {
                    planId: this.testPlanId,
                    stepsId: this.stepInputListId,
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
