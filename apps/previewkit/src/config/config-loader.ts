import yaml from "js-yaml";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { previewConfigSchema, type PreviewConfig } from "./schema";

const CONFIG_FILE = ".preview.yaml";

export async function loadPreviewConfig(
    provider: GitProvider,
    repoFullName: string,
    ref: string,
): Promise<PreviewConfig> {
    const raw = await provider.fetchFileContent(repoFullName, CONFIG_FILE, ref);
    if (!raw) {
        throw new Error(`No ${CONFIG_FILE} found in ${repoFullName} at ref ${ref}`);
    }

    const parsed = yaml.load(raw);
    const result = previewConfigSchema.safeParse(parsed);

    if (!result.success) {
        logger.error(`Invalid ${CONFIG_FILE} in ${repoFullName}`, { errors: result.error.flatten() });
        throw new Error(
            `Invalid ${CONFIG_FILE}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
        );
    }

    return result.data;
}
