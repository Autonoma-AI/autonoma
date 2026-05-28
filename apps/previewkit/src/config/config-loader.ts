import yaml from "js-yaml";
import type { GitProvider } from "../git-provider/git-provider";
import { logger } from "../logger";
import { previewConfigSchema, type PreviewConfig } from "./schema";

const CONFIG_FILES = [".preview.yaml", ".preview.yml"];

/**
 * Returns the parsed config file, or `undefined` when the repo doesn't
 * have one at this ref. Tries `.preview.yaml` first, then `.preview.yml`.
 * A missing file is a normal opt-out signal (most repos under an installed
 * GitHub App will never have one) - only an invalid file throws, since that's
 * a user mistake worth surfacing.
 */
export async function loadPreviewConfig(
    provider: GitProvider,
    repoFullName: string,
    ref: string,
): Promise<PreviewConfig | undefined> {
    let raw: string | undefined;
    let configFile: string | undefined;

    for (const candidate of CONFIG_FILES) {
        raw = await provider.fetchFileContent(repoFullName, candidate, ref);
        if (raw != null) {
            configFile = candidate;
            break;
        }
    }

    if (raw == null || configFile == null) {
        return undefined;
    }

    const parsed = yaml.load(raw);
    const result = previewConfigSchema.safeParse(parsed);

    if (!result.success) {
        logger.error(`Invalid ${configFile} in ${repoFullName}`, { errors: result.error.flatten() });
        throw new Error(
            `Invalid ${configFile}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
        );
    }

    return result.data;
}
