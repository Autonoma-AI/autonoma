import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    GenerationAPIRunner,
    type PlanData,
    type TestCase,
    buildExecutionPrompt,
    buildSkillsConfigFromPlanData,
} from "@autonoma/engine";
import { logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { AuthPayloadSchema } from "@autonoma/types";
import type { MobileApplicationData, MobileContext } from "../../platform";
import type { MobileCommandSpec } from "../mobile-agent";

type GenerationAPIRunnerConfig = ConstructorParameters<
    typeof GenerationAPIRunner<MobileCommandSpec, MobileContext, MobileApplicationData>
>[0] & {
    storageProvider: StorageProvider;
};

export class MobileGenerationAPIRunner extends GenerationAPIRunner<
    MobileCommandSpec,
    MobileContext,
    MobileApplicationData
> {
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
}
