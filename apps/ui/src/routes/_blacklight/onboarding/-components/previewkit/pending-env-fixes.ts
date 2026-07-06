import type { SuggestedEnvVar } from "@autonoma/types";

export interface PendingEnvFix {
    appName: string;
    vars: SuggestedEnvVar[];
}

const pendingByApplication = new Map<string, PendingEnvFix[]>();

/** Queues fixes for an application, merging with any already pending. */
export function queueEnvFixes(applicationId: string, fixes: PendingEnvFix[]): void {
    if (fixes.length === 0) return;
    const existing = pendingByApplication.get(applicationId) ?? [];
    pendingByApplication.set(applicationId, [...existing, ...fixes]);
}

/** Returns and clears the pending fixes for an application (applied once). */
export function consumeEnvFixes(applicationId: string): PendingEnvFix[] {
    const fixes = pendingByApplication.get(applicationId) ?? [];
    pendingByApplication.delete(applicationId);
    return fixes;
}
