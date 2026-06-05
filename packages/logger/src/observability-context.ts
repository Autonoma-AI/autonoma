import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/**
 * Canonical observability schema, broken into atomic groups.
 *
 * Design rule: every top-level group is optional, but each group's *required*
 * fields are non-optional. That means a caller who decides to set "we know the
 * Temporal context" can't half-set it (e.g. workflowId without temporalRunId)
 * - Zod rejects the partial group at validation time. Adding new IDs is a
 * matter of growing the appropriate group or adding a new one.
 *
 * Storage is nested (this shape goes into AsyncLocalStorage). Emission is flat
 * - the logger backend flattens each group before writing to Sentry tags,
 * console output, and PostHog properties, so consumers still see one IDs
 * level deep (snapshotId, branchId, workflowId, ...).
 *
 * Rules:
 * - All field names are camelCase. No snake_case.
 * - One concept, one name. Never both `runId` and `run_id`.
 * - Add new fields to an existing group or create a new group. Don't invent
 *   ad-hoc keys at call sites - put non-canonical fields under `extra:`.
 */

const TemporalContextSchema = z.object({
    workflowId: z.string().min(1),
    workflowType: z.string().min(1),
    temporalRunId: z.string().min(1),
    taskQueue: z.string().min(1),
    attempt: z.number().int().nonnegative(),
    activityType: z.string().min(1).optional(),
    activityId: z.string().min(1).optional(),
});

const OrganizationContextSchema = z.object({
    organizationId: z.string().min(1),
});

const ApplicationContextSchema = z.object({
    applicationId: z.string().min(1),
});

const BranchContextSchema = z.object({
    branchId: z.string().min(1),
});

const SnapshotContextSchema = z.object({
    snapshotId: z.string().min(1),
    headSha: z.string().min(1).optional(),
    baseSha: z.string().min(1).optional(),
    prevSnapshotId: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
});

const RefinementLoopContextSchema = z.object({
    loopId: z.string().min(1),
    triggeredBy: z.enum(["onboarding", "diffs"]),
});

const RefinementIterationContextSchema = z.object({
    iterationId: z.string().min(1),
    iterationNumber: z.number().int().positive(),
});

const TestCaseContextSchema = z.object({
    testCaseId: z.string().min(1),
    planId: z.string().min(1).optional(),
});

const TestGenerationContextSchema = z.object({
    testGenerationId: z.string().min(1),
});

const RunContextSchema = z.object({
    runId: z.string().min(1),
});

const JobContextSchema = z.object({
    jobName: z.string().min(1),
    executionMode: z.enum(["job", "service"]).optional(),
});

const CompactionContextSchema = z.object({
    strategy: z.string().min(1),
    messagesAffected: z.number().int().nonnegative().optional(),
});

export const ObservabilityContextSchema = z.object({
    temporal: TemporalContextSchema.optional(),
    organization: OrganizationContextSchema.optional(),
    application: ApplicationContextSchema.optional(),
    branch: BranchContextSchema.optional(),
    snapshot: SnapshotContextSchema.optional(),
    refinementLoop: RefinementLoopContextSchema.optional(),
    refinementIteration: RefinementIterationContextSchema.optional(),
    testCase: TestCaseContextSchema.optional(),
    testGeneration: TestGenerationContextSchema.optional(),
    run: RunContextSchema.optional(),
    job: JobContextSchema.optional(),
    compaction: CompactionContextSchema.optional(),
});

export type ObservabilityContext = z.infer<typeof ObservabilityContextSchema>;
export type TemporalContext = z.infer<typeof TemporalContextSchema>;
export type OrganizationContext = z.infer<typeof OrganizationContextSchema>;
export type ApplicationContext = z.infer<typeof ApplicationContextSchema>;
export type BranchContext = z.infer<typeof BranchContextSchema>;
export type SnapshotContext = z.infer<typeof SnapshotContextSchema>;
export type RefinementLoopContext = z.infer<typeof RefinementLoopContextSchema>;
export type RefinementIterationContext = z.infer<typeof RefinementIterationContextSchema>;
export type TestCaseContext = z.infer<typeof TestCaseContextSchema>;
export type TestGenerationContext = z.infer<typeof TestGenerationContextSchema>;
export type RunContext = z.infer<typeof RunContextSchema>;
export type JobContext = z.infer<typeof JobContextSchema>;
export type CompactionContext = z.infer<typeof CompactionContextSchema>;

/**
 * Any structured payload passed to a log call. Canonical groups go at the top
 * level; everything else goes under `extra`.
 */
export type LogExtra = ObservabilityContext & {
    extra?: Record<string, unknown>;
};

const als = new AsyncLocalStorage<ObservabilityContext>();

/** Run a callback with an observability context bound to its async scope. */
export function withObservabilityContext<T>(ctx: ObservabilityContext, fn: () => T): T {
    const parent = als.getStore();
    const merged = mergeContexts(parent ?? {}, ctx);
    return als.run(merged, fn);
}

/** Get the currently-bound context, or an empty object when outside any scope. */
export function getObservabilityContext(): ObservabilityContext {
    return als.getStore() ?? {};
}

/**
 * Merge additional fields into the current ALS frame. No-op when called outside
 * a `withObservabilityContext` scope, so it is always safe to call.
 *
 * Deep-merges per group so calling `extendObservabilityContext({ snapshot: { headSha } })`
 * after the snapshot group already has `{ snapshotId }` keeps both fields.
 */
export function extendObservabilityContext(extra: ObservabilityContext): void {
    const current = als.getStore();
    if (current == null) return;
    Object.assign(current, mergeContexts(current, extra));
}

function mergeContexts(a: ObservabilityContext, b: ObservabilityContext): ObservabilityContext {
    const out: ObservabilityContext = { ...a };
    for (const key of OBSERVABILITY_GROUP_KEYS) {
        const av = a[key];
        const bv = b[key];
        if (bv == null) continue;
        Object.assign(out, { [key]: av == null ? bv : { ...av, ...bv } });
    }
    return out;
}

/**
 * Validate-and-pick canonical fields off an unknown shape. Accepts both the
 * nested shape and a flat record (used by the Temporal activity interceptor
 * to lift IDs off raw activity inputs without ever type-asserting). Drops
 * unknown / invalid fields; never throws.
 */
export function pickObservabilityContext(value: unknown): ObservabilityContext {
    if (typeof value !== "object" || value === null) return {};
    // Strict parse only succeeds when the input already uses our group keys.
    // For flat inputs (activity args like { snapshotId, iterationId }), fall
    // back to the per-group flat lifter.
    const nested = ObservabilityContextSchema.strict().safeParse(value);
    if (nested.success) return nested.data;
    return liftFlatToGroups(value);
}

/**
 * Map a flat record like `{ snapshotId, iterationId, iterationNumber }` to the
 * grouped shape `{ snapshot: { snapshotId }, refinementIteration: { iterationId, iterationNumber } }`.
 *
 * Only fields that pass the per-group schema land in the output; everything
 * else is dropped.
 */
function liftFlatToGroups(value: object): ObservabilityContext {
    const out: ObservabilityContext = {};
    for (const [key, schema] of GROUP_SCHEMAS) {
        const candidate: Record<string, unknown> = {};
        let hasAny = false;
        for (const field of GROUP_FIELDS[key]) {
            if (!(field in value)) continue;
            candidate[field] = Reflect.get(value, field);
            hasAny = true;
        }
        if (!hasAny) continue;
        const parsed = schema.safeParse(candidate);
        if (parsed.success) Object.assign(out, { [key]: parsed.data });
    }
    return out;
}

/**
 * Flatten the grouped context to a single-level record. Used by the logger
 * backend to produce Sentry tags / console payloads / PostHog properties that
 * carry every canonical ID as a flat key (snapshotId, workflowId, ...).
 *
 * Last-writer-wins on key collisions, but the schema groups don't share field
 * names so collisions don't happen in practice.
 */
export function flattenObservabilityContext(ctx: ObservabilityContext): Record<string, string | number> {
    const flat: Record<string, string | number> = {};
    for (const key of OBSERVABILITY_GROUP_KEYS) {
        const group = ctx[key];
        if (group == null) continue;
        for (const [field, value] of Object.entries(group)) {
            if (value == null) continue;
            if (typeof value === "string" || typeof value === "number") flat[field] = value;
        }
    }
    return flat;
}

/** Tuple of top-level group keys. Sourced from the schema to stay in sync. */
export const OBSERVABILITY_GROUP_KEYS = ObservabilityContextSchema.keyof().options;

const GROUP_SCHEMAS = [
    ["temporal", TemporalContextSchema],
    ["organization", OrganizationContextSchema],
    ["application", ApplicationContextSchema],
    ["branch", BranchContextSchema],
    ["snapshot", SnapshotContextSchema],
    ["refinementLoop", RefinementLoopContextSchema],
    ["refinementIteration", RefinementIterationContextSchema],
    ["testCase", TestCaseContextSchema],
    ["testGeneration", TestGenerationContextSchema],
    ["run", RunContextSchema],
    ["job", JobContextSchema],
    ["compaction", CompactionContextSchema],
] as const;

const GROUP_FIELDS = {
    temporal: TemporalContextSchema.keyof().options,
    organization: OrganizationContextSchema.keyof().options,
    application: ApplicationContextSchema.keyof().options,
    branch: BranchContextSchema.keyof().options,
    snapshot: SnapshotContextSchema.keyof().options,
    refinementLoop: RefinementLoopContextSchema.keyof().options,
    refinementIteration: RefinementIterationContextSchema.keyof().options,
    testCase: TestCaseContextSchema.keyof().options,
    testGeneration: TestGenerationContextSchema.keyof().options,
    run: RunContextSchema.keyof().options,
    job: JobContextSchema.keyof().options,
    compaction: CompactionContextSchema.keyof().options,
} as const;
