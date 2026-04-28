import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@autonoma/db";
import type { Screenshot } from "@autonoma/image";
import { type Logger, logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { CommandOutput, CommandParams, CommandSpec } from "../../commands";
import type { ReplayRunResult } from "../runner/replay-runner";

export interface PersistableRunStep<TSpec extends CommandSpec> {
    interaction: TSpec["interaction"];
    params: CommandParams<TSpec>;
    output?: CommandOutput<TSpec>;
    error?: Error;

    beforeScreenshot?: Screenshot;
    afterScreenshot?: Screenshot;
}

export interface RunData {
    run: {
        id: string;
        assignmentId: string;
    };
    assignment: {
        stepsId: string;
        testCase: { id: string; name: string };
    };
    application: {
        id: string;
        name: string;
        architecture: string;
        organizationId: string;
    };
    snapshot: {
        branch: {
            deployment: {
                webDeployment: { url: string; file: string } | null;
                mobileDeployment: { packageUrl: string; packageName: string; photo: string } | null;
            } | null;
        };
    };
    scenarioInstance: {
        auth: Record<string, unknown> | null;
        resolvedVariables: Record<string, string> | null;
    } | null;
    steps: Array<{
        order: number;
        interaction: string;
        params: unknown;
        waitCondition: string | null;
    }>;
}

export interface RunPersisterConfig {
    db: PrismaClient;
    storageProvider: StorageProvider;
    runId: string;
    videoExtension: string;
}

export class RunPersister<TSpec extends CommandSpec> {
    private readonly logger: Logger;

    private organizationId?: string;
    private stepOutputListId?: string;

    constructor(private readonly config: RunPersisterConfig) {
        this.logger = logger.child({ name: "RunPersister", runId: this.id });
    }

    private get id() {
        return this.config.runId;
    }

    private get db() {
        return this.config.db;
    }

    public async markRunning(): Promise<RunData> {
        this.logger.info("Marking run as running");

        const run = await this.db.run.findFirstOrThrow({
            where: { id: this.id },
            include: {
                scenarioInstance: {
                    select: { auth: true, resolvedVariables: true },
                },
                assignment: {
                    include: {
                        steps: {
                            include: {
                                list: {
                                    orderBy: { order: "asc" },
                                },
                            },
                        },
                        testCase: {
                            include: {
                                application: {
                                    select: {
                                        id: true,
                                        name: true,
                                        architecture: true,
                                        organizationId: true,
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
                    },
                },
            },
        });

        if (run.assignment.stepsId == null || run.assignment.steps == null) {
            throw new Error(`Run assignment has no steps configured (assignmentId: ${run.assignmentId})`);
        }

        this.organizationId = run.assignment.testCase.application.organizationId;

        const stepOutputList = await this.db.stepOutputList.create({
            data: {
                runId: this.id,
                organizationId: this.organizationId,
            },
            select: { id: true },
        });
        this.stepOutputListId = stepOutputList.id;

        await this.db.run.update({
            where: { id: this.id },
            data: {
                status: "running",
                startedAt: new Date(),
            },
        });

        const steps = run.assignment.steps.list.map((step) => ({
            order: step.order,
            interaction: step.interaction,
            params: step.params,
            waitCondition: step.waitCondition ?? null,
        }));

        return {
            run: { id: run.id, assignmentId: run.assignmentId },
            assignment: {
                stepsId: run.assignment.stepsId,
                testCase: { id: run.assignment.testCase.id, name: run.assignment.testCase.name },
            },
            application: run.assignment.testCase.application,
            snapshot: run.assignment.snapshot,
            scenarioInstance: run.scenarioInstance ?? null,
            steps,
        };
    }

    public async markFailed(): Promise<void> {
        this.logger.info("Marking run as failed");
        await this.db.run.update({
            where: { id: this.id },
            data: {
                status: "failed",
                completedAt: new Date(),
            },
        });
    }

    public async recordStep(step: PersistableRunStep<TSpec>, index: number): Promise<void> {
        this.logger.info("Persisting run step", { interaction: step.interaction, index });

        if (this.stepOutputListId == null || this.organizationId == null) {
            throw new Error("Step output list not initialized - call markRunning() first");
        }

        let screenshotBeforeUrl: string | undefined = undefined;
        let screenshotAfterUrl: string | undefined = undefined;
        try {
            const uploads = await Promise.all([
                step.beforeScreenshot != null
                    ? this.config.storageProvider.upload(
                          this.screenshotKey(this.id, index, "before"),
                          step.beforeScreenshot.buffer,
                      )
                    : Promise.resolve(undefined),
                step.afterScreenshot != null
                    ? this.config.storageProvider.upload(
                          this.screenshotKey(this.id, index, "after"),
                          step.afterScreenshot.buffer,
                      )
                    : Promise.resolve(undefined),
            ]);
            screenshotBeforeUrl = uploads[0];
            screenshotAfterUrl = uploads[1];
        } catch (error) {
            this.logger.error("Failed to upload run step screenshots", error);
            throw error;
        }

        const stepInputId = await this.getStepInputId(step.interaction, index);

        await this.db.stepOutput.create({
            data: {
                listId: this.stepOutputListId,
                organizationId: this.organizationId,
                order: index,
                output: (step.output ?? { outcome: step.error?.message ?? "failed" }) as object,
                stepInputId,
                screenshotBefore: screenshotBeforeUrl,
                screenshotAfter: screenshotAfterUrl,
            },
        });

        this.logger.info("Run step persisted", { index });
    }

    public async markCompleted({ result, videoPath }: ReplayRunResult<TSpec>): Promise<void> {
        this.logger.info("Marking run as completed", { success: result.success });

        await this.db.run.update({
            where: { id: this.id },
            data: {
                status: result.success ? "success" : "failed",
                completedAt: new Date(),
                reasoning: result.reasoning ?? null,
            },
        });

        if (result.success) {
            await this.tryAutoResolveBugs();
        }

        this.logger.info("Uploading run video", { videoPath });
        const videoBuffer = await readFile(videoPath);
        await this.config.storageProvider.upload(this.videoKey(this.id), videoBuffer);

        this.logger.info("Run completed and video uploaded");
    }

    private async tryAutoResolveBugs(): Promise<void> {
        try {
            const run = await this.db.run.findUniqueOrThrow({
                where: { id: this.id },
                select: {
                    assignment: {
                        select: {
                            testCaseId: true,
                            snapshot: { select: { branchId: true } },
                        },
                    },
                },
            });

            const { testCaseId } = run.assignment;
            const { branchId } = run.assignment.snapshot;

            const result = await this.db.bug.updateMany({
                where: {
                    branchId,
                    testCaseId,
                    status: { in: ["open", "regressed"] },
                },
                data: {
                    status: "resolved",
                    resolvedAt: new Date(),
                },
            });

            if (result.count > 0) {
                this.logger.info("Auto-resolved bugs after successful run", {
                    resolvedCount: result.count,
                    branchId,
                    testCaseId,
                });
            }
        } catch (error) {
            this.logger.error("Failed to auto-resolve bugs", error);
        }
    }

    private async getStepInputId(_interaction: string, index: number): Promise<string> {
        const run = await this.db.run.findFirstOrThrow({
            where: { id: this.id },
            select: { assignment: { select: { stepsId: true } } },
        });

        const stepsId = run.assignment.stepsId;
        if (stepsId == null) throw new Error("Assignment has no stepsId");

        const stepInput = await this.db.stepInput.findFirstOrThrow({
            where: { listId: stepsId, order: index },
            select: { id: true },
        });

        return stepInput.id;
    }

    private screenshotKey(runId: string, order: number, phase: "before" | "after") {
        return `run/${runId}/step-${order}-${phase}.png`;
    }

    private videoKey(runId: string) {
        return `run/${runId}/video.${this.config.videoExtension}`;
    }
}
