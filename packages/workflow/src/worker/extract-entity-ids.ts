export interface EntityIds {
    snapshotId?: string;
    testGenerationId?: string;
}

/**
 * Pulled out of sentry-service-interceptor.ts so it can be unit-tested without pulling in that
 * file's `@autonoma/db` import chain - a hermetic workflow test must not require a database, and
 * CI runs this package's tests without one (see test/global-setup.ts).
 */
export function extractEntityIds(args: readonly unknown[]): EntityIds {
    const out: EntityIds = {};
    for (const arg of args) {
        if (typeof arg !== "object" || arg == null) continue;
        if (out.snapshotId == null && "snapshotId" in arg) {
            const value: unknown = arg.snapshotId;
            if (typeof value === "string" && value.length > 0) out.snapshotId = value;
        }
        if (out.testGenerationId == null && "testGenerationId" in arg) {
            const value: unknown = arg.testGenerationId;
            if (typeof value === "string" && value.length > 0) out.testGenerationId = value;
        }
        // `generationId` names the same TestGeneration id under a different, equally common
        // convention (e.g. ReviewGenerationInput) - recognized as an alias so an activity gets
        // automatic observability/billing attribution without renaming its own field.
        if (out.testGenerationId == null && "generationId" in arg) {
            const value: unknown = arg.generationId;
            if (typeof value === "string" && value.length > 0) out.testGenerationId = value;
        }
    }
    return out;
}
