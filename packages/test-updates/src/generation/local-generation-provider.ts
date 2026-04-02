import { fork } from "node:child_process";
import path from "node:path";

import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { GenerationSubject, type ScenarioManager } from "@autonoma/scenario";
import { fx } from "@autonoma/try";
import type { WorkflowArchitecture } from "@autonoma/workflow";

import { TestSuiteUpdater } from "../test-update-manager";
import type { GenerationJobOptions, GenerationProvider, PendingGeneration } from "./generation-job-provider";

const ENGINE_WEB_ENTRY_POINT = path.resolve(
    import.meta.dirname,
    "../../../../apps/engine-web/src/execution-agent/generation-api/run-generation-job.ts",
);
const ENGINE_MOBILE_ENTRY_POINT = path.resolve(
    import.meta.dirname,
    "../../../../apps/engine-mobile/src/execution-agent/generation-api/run-generation-job.ts",
);

const ENTRY_POINTS: Record<WorkflowArchitecture, string> = {
    WEB: ENGINE_WEB_ENTRY_POINT,
    IOS: ENGINE_MOBILE_ENTRY_POINT,
    ANDROID: ENGINE_MOBILE_ENTRY_POINT,
};

interface LocalGenerationProviderParams {
    db: PrismaClient;
    scenarioManager: ScenarioManager;
    /** Max concurrent generation processes. Defaults to 2. */
    concurrency?: number;
}

export class LocalGenerationProvider implements GenerationProvider {
    private readonly logger: Logger;

    private readonly db: PrismaClient;
    private readonly scenarioManager: ScenarioManager;
    private readonly concurrency: number;

    constructor({ db, scenarioManager, concurrency }: LocalGenerationProviderParams) {
        this.logger = logger.child({ name: this.constructor.name });
        this.db = db;
        this.scenarioManager = scenarioManager;
        this.concurrency = concurrency ?? 2;
    }

    async fireJobs(generations: PendingGeneration[], options?: GenerationJobOptions): Promise<void> {
        const firstGeneration = generations[0];
        if (firstGeneration == null) return;

        this.logger.info("Running generations locally", {
            testGenerationIds: generations.map((g) => g.testGenerationId),
            concurrency: this.concurrency,
            autoActivate: options?.autoActivate,
        });

        await this.runGenerationsWithConcurrency(generations);

        this.logger.info("All local generations complete, assigning results", {
            testGenerationIds: generations.map((g) => g.testGenerationId),
        });

        const generationRecord = await this.db.testGeneration.findUniqueOrThrow({
            // biome-ignore lint/style/noNonNullAssertion: validated by caller (generations is non-empty)
            where: { id: generations[0]!.testGenerationId! },
            select: { snapshot: { select: { branchId: true } } },
        });

        const branchId = generationRecord.snapshot.branchId;
        const updater = await TestSuiteUpdater.continueUpdate({
            db: this.db,
            branchId,
        });
        const { assigned, failed } = await updater.assignGenerationResults(generations.map((g) => g.testGenerationId));

        this.logger.info("Generation results assigned", { assigned, failed });

        if (options?.autoActivate === true) {
            await updater.finalize();
            this.logger.info("Snapshot finalized");
        }
    }

    private async runGenerationsWithConcurrency(generations: PendingGeneration[]): Promise<void> {
        const queue = [...generations];
        const running = new Set<Promise<void>>();

        while (queue.length > 0 || running.size > 0) {
            while (running.size < this.concurrency && queue.length > 0) {
                // biome-ignore lint/style/noNonNullAssertion: checked by while condition
                const generation = queue.shift()!;
                const promise = this.runSingleGeneration(generation).finally(() => running.delete(promise));
                running.add(promise);
            }

            if (running.size > 0) {
                await Promise.race(running);
            }
        }
    }

    private async runSingleGeneration(generation: PendingGeneration): Promise<void> {
        const { testGenerationId, scenarioId } = generation;
        let scenarioInstanceId: string | undefined;

        if (scenarioId != null) {
            const subject = new GenerationSubject(this.db, testGenerationId);
            const [instance, upError] = await fx.runAsync(() => this.scenarioManager.up(subject, scenarioId));
            if (upError != null) {
                this.logger.error("Scenario up failed, skipping generation", {
                    testGenerationId,
                    error: upError.message,
                });
                return;
            }
            scenarioInstanceId = instance.id;
            this.logger.info("Scenario up completed", { testGenerationId, scenarioInstanceId });
        }

        try {
            await this.forkGenerationProcess(generation);
        } finally {
            if (scenarioInstanceId != null) {
                const [, downError] = await fx.runAsync(() => this.scenarioManager.down(scenarioInstanceId));
                if (downError != null) {
                    this.logger.error("Scenario down failed", {
                        testGenerationId,
                        scenarioInstanceId,
                        error: downError.message,
                    });
                } else {
                    this.logger.info("Scenario down completed", { testGenerationId, scenarioInstanceId });
                }
            }
        }
    }

    private forkGenerationProcess(generation: PendingGeneration): Promise<void> {
        const { testGenerationId } = generation;
        const entryPoint = ENTRY_POINTS[generation.architecture];

        return new Promise<void>((resolve, reject) => {
            this.logger.info("Forking generation process", { testGenerationId });

            const child = fork(entryPoint, [testGenerationId], {
                execArgv: ["--import", "tsx"],
                stdio: "inherit",
            });

            child.on("exit", (code) => {
                if (code === 0) {
                    this.logger.info("Generation process completed", { testGenerationId });
                    resolve();
                } else {
                    this.logger.error("Generation process failed", { testGenerationId, exitCode: code });
                    // Don't reject - the generation-assigner handles failed generations gracefully.
                    resolve();
                }
            });

            child.on("error", (error) => {
                this.logger.error("Generation process error", { testGenerationId, error });
                reject(error);
            });
        });
    }
}
