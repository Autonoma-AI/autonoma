import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunAPIRunner, type RunAPIRunnerConfig, type RunData } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { AuthPayloadSchema } from "@autonoma/types";
import type { MobileApplicationData, MobileContext, MobilePlatform } from "../platform";
import type { ReplayMobileCommandSpec } from "./mobile-command-spec";

const DEFAULT_RESOLUTION = { width: 1440, height: 2560 };

type MobileRunAPIRunnerConfig = RunAPIRunnerConfig<ReplayMobileCommandSpec, MobileApplicationData, MobileContext> & {
    storageProvider: StorageProvider;
};

export class MobileRunAPIRunner extends RunAPIRunner<ReplayMobileCommandSpec, MobileContext, MobileApplicationData> {
    private readonly mobileLogger = rootLogger.child({ name: "MobileRunAPIRunner" });
    private readonly tmpPhotoFiles = new Set<string>();
    private readonly storageProvider: StorageProvider;

    constructor(config: MobileRunAPIRunnerConfig) {
        const { storageProvider, ...runnerConfig } = config;
        super(runnerConfig);
        this.storageProvider = storageProvider;
    }

    public async parseRunData(data: RunData): Promise<MobileApplicationData> {
        const mobileDeployment = data.snapshot.branch.deployment?.mobileDeployment;
        if (mobileDeployment == null) {
            throw new Error(`Application "${data.application.name}" has no mobile deployment`);
        }

        const architecture = data.application.architecture;
        if (architecture === "WEB") {
            throw new Error("Web architecture is not supported for mobile replay");
        }
        const platform = architecture as MobilePlatform;

        const authParsed = AuthPayloadSchema.safeParse(data.scenarioInstance?.auth);
        const auth = authParsed.success ? authParsed.data : undefined;
        const credentials = auth?.credentials;

        if (credentials != null) {
            for (const [key, value] of Object.entries(credentials)) {
                this.memory.set(key, value);
            }
        }

        const resolvedVars = data.scenarioInstance?.resolvedVariables as Record<string, unknown> | undefined;
        if (resolvedVars != null) {
            for (const [key, value] of Object.entries(resolvedVars)) {
                if (value != null && !this.memory.has(key)) {
                    this.memory.set(key, String(value));
                }
            }
        }

        const photo = await this.resolvePhotoFilePath(mobileDeployment.photo);

        this.mobileLogger.info("Parsed run application data", {
            platform,
            packageUrl: mobileDeployment.packageUrl,
            packageName: mobileDeployment.packageName,
            hasCredentials: credentials != null,
            hasPhoto: photo != null,
        });

        setScreenshotConfig({
            screenResolution: DEFAULT_RESOLUTION,
            architecture: "mobile",
        });

        return {
            platform,
            packageUrl: mobileDeployment.packageUrl,
            packageName: mobileDeployment.packageName,
            photo,
        };
    }

    private async resolvePhotoFilePath(fileKey: string): Promise<string> {
        this.mobileLogger.info("Downloading photo from S3", { fileKey });
        const buffer = await this.storageProvider.download(fileKey);
        const filename = `${Date.now()}-${path.basename(fileKey)}`;
        const tmpPath = path.join(os.tmpdir(), filename);
        await writeFile(tmpPath, buffer);
        this.tmpPhotoFiles.add(tmpPath);
        this.mobileLogger.info("Photo written to tmp path", { tmpPath });
        return tmpPath;
    }

    public async cleanupPhotoFiles(): Promise<void> {
        for (const tmpFile of this.tmpPhotoFiles) {
            try {
                await unlink(tmpFile);
                this.mobileLogger.info("Deleted tmp photo file", { tmpFile });
            } catch (error) {
                this.mobileLogger.warn("Failed to delete tmp photo file", { tmpFile, error });
            }
        }
        this.tmpPhotoFiles.clear();
    }
}
