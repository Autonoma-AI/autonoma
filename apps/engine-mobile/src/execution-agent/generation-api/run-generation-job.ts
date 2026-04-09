import "dotenv/config";

import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import {
    GenerationAPIRunner,
    GenerationPersister,
    type PlanData,
    type TestCase,
    buildExecutionPrompt,
    buildSkillsConfigFromPlanData,
    createEngineModelRegistry,
} from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { S3Storage, type StorageProvider } from "@autonoma/storage";
import { AuthPayloadSchema } from "@autonoma/types";
import { type MobileApplicationData, type MobileContext, MobileInstaller } from "../../platform";
import { type MobileCommandSpec, createMobileAgentFactory } from "../mobile-agent";

const DEFAULT_RESOLUTION = { width: 1440, height: 2560 };
const VIDEO_EXTENSION = "mp4";

type GenerationAPIRunnerConfig = ConstructorParameters<
    typeof GenerationAPIRunner<MobileCommandSpec, MobileContext, MobileApplicationData>
>[0] & {
    storageProvider: StorageProvider;
};

class MobileGenerationAPIRunner extends GenerationAPIRunner<MobileCommandSpec, MobileContext, MobileApplicationData> {
    private readonly tmpPhotoFiles = new Set<string>();
    private readonly photoLogger = rootLogger.child({ name: "mobile-generation-photo" });
    private readonly storageProvider: StorageProvider;

    constructor(config: GenerationAPIRunnerConfig) {
        const { storageProvider, ...runnerConfig } = config;
        super(runnerConfig);
        this.storageProvider = storageProvider;
    }

    public async parsePlanData(planData: PlanData): Promise<TestCase & MobileApplicationData> {
        const { testPlan, snapshot } = planData;
        const application = testPlan.testCase.application;
        const mobileDeployment = snapshot?.deployment?.mobileDeployment;
        if (mobileDeployment == null) {
            throw new Error(`Application "${application.name}" has no mobile deployment`);
        }
        if (mobileDeployment.photo == null) {
            throw new Error(`Application "${application.name}" has no default photo configured`);
        }

        const photo = await this.resolvePhotoFilePath(mobileDeployment.photo);

        const skillsConfig = buildSkillsConfigFromPlanData(planData);

        const authParsed = AuthPayloadSchema.safeParse(planData.scenarioInstance?.auth);
        const auth = authParsed.success ? authParsed.data : undefined;
        const credentials = auth?.credentials;

        if (application.architecture === "WEB") {
            this.logger.fatal("Web architecture is not supported for mobile generation", { testPlanId: testPlan.id });
            throw new Error("Web architecture is not supported for mobile generation");
        }

        return {
            name: testPlan.testCase.name,
            prompt: buildExecutionPrompt(testPlan.prompt, application.customInstructions, credentials),
            platform: application.architecture,
            packageUrl: mobileDeployment.packageUrl,
            packageName: mobileDeployment.packageName,
            photo,
            skillsConfig,
            credentials,
        };
    }

    private async resolvePhotoFilePath(fileKey: string): Promise<string> {
        this.photoLogger.info("Downloading photo from S3", { fileKey });
        const buffer = await this.storageProvider.download(fileKey);
        const filename = `${Date.now()}-${path.basename(fileKey)}`;
        const tmpPath = path.join(os.tmpdir(), filename);
        writeFileSync(tmpPath, buffer);
        this.tmpPhotoFiles.add(tmpPath);
        this.photoLogger.info("Photo written to tmp path", { tmpPath });
        return tmpPath;
    }

    public async cleanupPhotoFiles() {
        for (const tmpFile of this.tmpPhotoFiles) {
            try {
                await unlink(tmpFile);
                this.photoLogger.info("Deleted tmp photo file", { tmpFile });
            } catch (error) {
                this.photoLogger.warn("Failed to delete tmp photo file", { tmpFile, error });
            }
        }
        this.tmpPhotoFiles.clear();
    }
}

async function main(testGenerationId: string) {
    const logger = rootLogger.child({
        name: "run-generation-job",
        testGenerationId,
    });

    setScreenshotConfig({
        screenResolution: DEFAULT_RESOLUTION,
        architecture: "mobile",
    });

    const storageProvider = S3Storage.createFromEnv();
    const generationPersister = new GenerationPersister<MobileCommandSpec>({
        db,
        storageProvider,
        testGenerationId,
        videoExtension: VIDEO_EXTENSION,
    });

    let installer: MobileInstaller | undefined;
    let runner: MobileGenerationAPIRunner | undefined;

    try {
        const generation = await db.testGeneration.findUniqueOrThrow({
            where: { id: testGenerationId },
            select: {
                testPlan: { select: { testCase: { select: { application: { select: { architecture: true } } } } } },
            },
        });
        const architecture = generation.testPlan.testCase.application.architecture;
        if (architecture === "WEB") throw new Error("Web architecture is not supported for mobile generation");

        const costCollector = new CostCollector();
        const models = createEngineModelRegistry(costCollector);
        installer = MobileInstaller.fromEnv(architecture, testGenerationId);

        runner = new MobileGenerationAPIRunner({
            storageProvider,
            installer,
            executionAgentFactory: createMobileAgentFactory(models),
            videoExtension: VIDEO_EXTENSION,
            generationPersister,
            costCollector,
        });

        await runner.runGeneration();
        logger.info("Generation job completed");
    } catch (error) {
        logger.error("Generation job failed", error);

        try {
            const reason = error instanceof Error ? error.message : "Unknown error";
            await generationPersister.markFailed(reason);
        } catch (markFailedError) {
            logger.error("Failed to mark generation as failed", markFailedError);
        }

        throw error;
    } finally {
        try {
            await runner?.cleanupPhotoFiles();
        } catch (error) {
            logger.error("Failed to cleanup tmp photo files", error);
        }

        if (installer != null) {
            try {
                await installer.cleanup();
            } catch (error) {
                logger.error("Failed to cleanup installer", error);
            }
        }

        try {
            writeFileSync("/tmp/flag/done", "");
        } catch (error) {
            logger.error("Failed to write flag file", error);
        }
    }
}

const args = process.argv.slice(2);
if (args.length !== 1) {
    console.error("Usage: tsx src/execution-agent/generation-api/run-generation-job.ts <testGenerationId>");
    process.exit(1);
}

// biome-ignore lint/style/noNonNullAssertion: Length === 1
const testGenerationId = args[0]!;

await runWithSentry({ name: "execution-agent-mobile", tags: { generation_id: testGenerationId } }, () =>
    main(testGenerationId),
);
