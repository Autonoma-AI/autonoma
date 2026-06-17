import { logger as rootLogger } from "@autonoma/logger";

const deriveLogger = rootLogger.child({ name: "derivePreviewSdkUrl" });

/**
 * Suggest the preview's SDK endpoint URL: the preview's primary app URL (origin)
 * combined with the path + query from the Application's main-branch webhook (the
 * SDK handler lives at the same path on the preview host). Falls back to the
 * preview origin alone when no main webhook is configured. Returns undefined
 * when the preview has no usable URL.
 *
 * Lives in its own module (no app `env` import) so it stays unit-testable without
 * the full API environment being configured.
 */
export function derivePreviewSdkUrl(
    primaryUrl: string | null | undefined,
    mainWebhookUrl: string | null | undefined,
): string | undefined {
    if (primaryUrl == null || primaryUrl === "") return undefined;
    const base = safeUrl(primaryUrl);
    if (base == null) return primaryUrl;

    if (mainWebhookUrl == null || mainWebhookUrl === "") return base.origin;

    const webhook = safeUrl(mainWebhookUrl);
    if (webhook == null) return base.origin;

    return `${base.origin}${webhook.pathname}${webhook.search}`;
}

function safeUrl(value: string): URL | undefined {
    try {
        return new URL(value);
    } catch (err) {
        deriveLogger.debug("Ignoring unparseable URL while deriving preview SDK URL", { value, err });
        return undefined;
    }
}
