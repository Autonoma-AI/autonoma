import type { Logger } from "@autonoma/logger";
import { previewConfigSchema } from "@autonoma/types";

/**
 * The env-var keys a PR's deployed preview config wires in - the half of the pod's environment that does NOT
 * live in the app's secret bundle.
 *
 * `undefined` (config absent or unparseable, e.g. wiped after ~60 days) is NOT an empty array: conflating them
 * presents half an environment as the whole one, turning a key nobody read into an absence that
 * `get_preview_env` calls decisive. A live classification degrades to the bundle alone; a capture refuses.
 */
export function readPreviewConnectionKeys(resolvedConfig: unknown, logger: Logger): string[] | undefined {
    if (resolvedConfig == null) {
        logger.warn("The preview has no stored resolved config, so its wired connection keys are unknown");
        return undefined;
    }

    const parsed = previewConfigSchema.safeParse(resolvedConfig);
    if (!parsed.success) {
        logger.warn("Could not parse the preview's resolved config", {
            extra: { issue: parsed.error.issues[0]?.message },
        });
        return undefined;
    }

    return [...new Set(parsed.data.apps.flatMap((app) => app.connections.map((connection) => connection.key)))];
}
