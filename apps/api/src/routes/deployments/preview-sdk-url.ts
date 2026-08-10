import { logger as rootLogger } from "@autonoma/logger";
import { buildSdkUrl, parseUrl } from "@autonoma/types";

const deriveLogger = rootLogger.child({ name: "derivePreviewSdkUrl" });

/**
 * Where the path of a preview's SDK endpoint can come from, strongest first.
 * The origin is never in question - it is the app that was actually deployed -
 * so everything here is about the path hanging off it.
 */
export interface PreviewSdkUrlSources {
    /** Preview origin of the app hosting the handler (`resolveSdkAppUrl`). */
    origin: string | null | undefined;
    /**
     * The `sdk_path` the environment's own config declares. Strongest: it is a
     * statement about the handler's code, made where the topology is described.
     */
    declaredPath?: string | null;
    /**
     * The application's main-branch webhook URL, whose path is borrowed when the
     * config declares none. Weak on purpose - the row can carry an endpoint from a
     * long-gone deploy - but it is the only record of a path a customer registered
     * by hand, so it still outranks the convention.
     */
    mainWebhookUrl?: string | null;
}

/**
 * The SDK endpoint to suggest for a preview: its origin, plus the strongest path
 * available. Falls back to the conventional path (`buildSdkUrl`'s default) when no
 * source names one, because an origin with no path is not an endpoint anything can
 * POST to.
 *
 * Returns undefined only when the preview has no usable origin.
 *
 * Lives in its own module (no app `env` import) so it stays unit-testable without
 * the full API environment being configured.
 */
export function derivePreviewSdkUrl({
    origin,
    declaredPath,
    mainWebhookUrl,
}: PreviewSdkUrlSources): string | undefined {
    if (origin == null || origin === "") return undefined;

    const base = safeUrl(origin);
    if (base == null) return origin;

    if (declaredPath != null && declaredPath !== "") return buildSdkUrl(base.origin, declaredPath);

    if (mainWebhookUrl == null || mainWebhookUrl === "") return buildSdkUrl(base.origin);

    const webhook = safeUrl(mainWebhookUrl);
    if (webhook == null) return buildSdkUrl(base.origin);

    return `${base.origin}${webhook.pathname}${webhook.search}`;
}

/** {@link parseUrl} with the breadcrumb this caller wants: an endpoint that will not parse is worth knowing about. */
function safeUrl(value: string): URL | undefined {
    const url = parseUrl(value);
    if (url == null) deriveLogger.debug("Ignoring unparseable URL while deriving preview SDK URL", { value });
    return url;
}
