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
import type { WebApplicationData, WebContext } from "../../platform";
import { toPlaywrightCookies } from "../../platform/scenario-auth";
import type { WebCommandSpec } from "../web-agent";

export class WebGenerationAPIRunner extends GenerationAPIRunner<WebCommandSpec, WebContext, WebApplicationData> {
    private readonly tmpUploadFiles = new Set<string>();
    private readonly uploadLogger = rootLogger.child({ name: "web-generation-upload" });
    private readonly storageProvider: StorageProvider;

    constructor(
        config: ConstructorParameters<typeof GenerationAPIRunner<WebCommandSpec, WebContext, WebApplicationData>>[0] & {
            storageProvider: StorageProvider;
        },
    ) {
        const { storageProvider, ...runnerConfig } = config;
        super(runnerConfig);
        this.storageProvider = storageProvider;
    }

    public async parsePlanData(planData: PlanData): Promise<TestCase & WebApplicationData> {
        const { testPlan, snapshot, scenarioInstance } = planData;
        const application = testPlan.testCase.application;
        const webDeployment = snapshot?.deployment?.webDeployment;
        if (webDeployment == null) {
            throw new Error(`Application "${application.name}" has no web deployment`);
        }
        if (webDeployment.file == null) {
            throw new Error(`Application "${application.name}" has no default upload file configured`);
        }

        const file = await this.resolveUploadFilePath(webDeployment.file);
        const skillsConfig = buildSkillsConfigFromPlanData(planData);

        const authParsed = AuthPayloadSchema.safeParse(scenarioInstance?.auth);
        const auth = authParsed.success ? authParsed.data : undefined;
        const cookies = auth?.cookies != null ? toPlaywrightCookies(auth.cookies, webDeployment.url) : undefined;

        return {
            name: testPlan.testCase.name,
            prompt: buildExecutionPrompt(testPlan.prompt, application.customInstructions, auth?.credentials),
            file,
            url: webDeployment.url,
            skillsConfig,
            cookies,
            headers: auth?.headers,
            credentials: auth?.credentials,
        };
    }

    public async cleanupUploadFiles() {
        for (const tmpFile of this.tmpUploadFiles) {
            try {
                await unlink(tmpFile);
                this.uploadLogger.info("Deleted tmp upload file", { tmpFile });
            } catch (error) {
                this.uploadLogger.warn("Failed to delete tmp upload file", { tmpFile, error });
            }
        }
        this.tmpUploadFiles.clear();
    }

    private async resolveUploadFilePath(fileKey: string): Promise<string> {
        this.uploadLogger.info("Downloading upload file from S3", { fileKey });

        const buffer = await this.storageProvider.download(fileKey);

        const filename = `${Date.now()}-${path.basename(fileKey)}`;
        const tmpPath = path.join(os.tmpdir(), filename);

        writeFileSync(tmpPath, buffer);
        this.tmpUploadFiles.add(tmpPath);

        this.uploadLogger.info("Upload file written to tmp path", { tmpPath });

        return tmpPath;
    }
}
