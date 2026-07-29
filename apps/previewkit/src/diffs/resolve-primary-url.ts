import { type AppRole, resolvePrimaryAppName } from "../config/schema";

export function resolvePrimaryUrl(apps: readonly AppRole[], urls: Record<string, string>): string | undefined {
    const primaryAppName = resolvePrimaryAppName(apps);
    if (primaryAppName == null) return undefined;
    return urls[primaryAppName];
}
