import { type AppRole, resolveSdkAppName } from "../config/schema";

/**
 * The preview origin of the app hosting the Environment Factory handler - the app
 * a scenario up/down must be sent to. Falls back to the primary app's URL for a
 * config with no `sdk_implemented` flag, so a full-stack app keeps working
 * untouched. Undefined when that app has no deployed URL.
 */
export function resolveSdkAppUrl(apps: readonly AppRole[], urls: Record<string, string>): string | undefined {
    const sdkAppName = resolveSdkAppName(apps);
    if (sdkAppName == null) return undefined;
    return urls[sdkAppName];
}
