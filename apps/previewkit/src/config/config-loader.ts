import yaml from "js-yaml";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { previewConfigSchema, type PreviewConfig } from "./schema";

const CONFIG_FILE = ".preview.yaml";

/**
 * Returns the parsed `.preview.yaml`, or `undefined` when the repo doesn't
 * have one at this ref. A missing file is a normal opt-out signal (most repos
 * under an installed GitHub App will never have one) — only an invalid file
 * throws, since that's a user mistake worth surfacing.
 */
export async function loadPreviewConfig(
    provider: GitProvider,
    repoFullName: string,
    ref: string,
): Promise<PreviewConfig | undefined> {
    const raw = await provider.fetchFileContent(repoFullName, CONFIG_FILE, ref);
    if (!raw) {
        return undefined;
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
