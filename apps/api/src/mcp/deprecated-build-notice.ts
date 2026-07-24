import { deprecatedBuildApps, type PreviewConfig } from "@autonoma/types";

/**
 * Warns a coding agent when the config it just read still has an app on a retired
 * framework preset. `apply_config` only accepts `runtime` / `dockerfile`, so an
 * agent that reads such a document, edits something unrelated and sends it back
 * would hit a validation error it has no context for. Returns undefined for a
 * document with nothing to convert, so the common case carries no noise.
 */
export function deprecatedBuildNotice(document: PreviewConfig): string | undefined {
    const stale = deprecatedBuildApps(document);
    if (stale.length === 0) return undefined;
    const list = stale.map((entry) => `${entry.app} (${entry.framework})`).join(", ");
    return (
        `This config predates the current build methods: ${list}. apply_config accepts only "runtime" and ` +
        `"dockerfile", so convert each of those apps before saving - "runtime" with the install and build commands ` +
        `in build_script and the start command as entrypoint is the direct equivalent. It still deploys as-is until ` +
        `you save, so convert it in the same edit rather than as a separate step.`
    );
}
