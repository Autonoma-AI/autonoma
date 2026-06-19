import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunAPIRunner, type RunData } from "@autonoma/engine";
import { setScreenshotConfig } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { AuthPayloadSchema } from "@autonoma/types";
import { buildWebApplicationData, type WebContext } from "../platform";
import type { WebApplicationData } from "../platform/web-application-data";
import type { ReplayWebCommandSpec } from "./web-command-spec";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

export class WebRunAPIRunner extends RunAPIRunner<ReplayWebCommandSpec, WebContext, WebApplicationData> {
    private readonly runLogger = rootLogger.child({ name: "WebRunAPIRunner" });
    constructor(
        config: ConstructorParameters<typeof RunAPIRunner<ReplayWebCommandSpec, WebContext, WebApplicationData>>[0] & {
            storageProvider: StorageProvider;
            urlOverride?: string;
        },
    ) {
        const { storageProvider, urlOverride, ...runnerConfig } = config;
        super(runnerConfig);
        this.storageProvider = storageProvider;
        this.urlOverride = urlOverride;
    }

    private readonly storageProvider: StorageProvider;
    private readonly urlOverride?: string;

    public async parseRunData(data: RunData): Promise<WebApplicationData> {
        const webDeployment = data.snapshot.branch.deployment?.webDeployment;
        if (webDeployment == null) {
            throw new Error(`Application "${data.application.name}" has no web deployment`);
        }

        const file = webDeployment.file != null ? await this.resolveUploadFilePath(webDeployment.file) : undefined;

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

        const webAppData = await buildWebApplicationData({ url: this.urlOverride ?? webDeployment.url, file, auth });

        this.runLogger.info("Parsed run application data", {
            url: webDeployment.url,
            hasFile: webAppData.file != null,
            hasCookies: webAppData.cookies != null,
            hasHeaders: webAppData.headers != null,
            hasCredentials: credentials != null,
        });

        setScreenshotConfig({
            screenResolution: DEFAULT_VIEWPORT,
            architecture: "web",
        });

        return webAppData;
    }

    private async resolveUploadFilePath(fileKey: string): Promise<string> {
        this.runLogger.info("Downloading upload file from S3", { fileKey });

        const buffer = await this.storageProvider.download(fileKey);

        const filename = `${Date.now()}-${path.basename(fileKey)}`;
        const tmpPath = path.join(os.tmpdir(), filename);

        writeFileSync(tmpPath, buffer);

        this.runLogger.info("Upload file written to tmp path", { tmpPath });

        return tmpPath;
    }
}
