import { z } from "zod";

// A derived view of a checkpoint/PR that keeps four concepts separate: open app bugs, execution
// state, engine-vs-app failure attribution, and suite changes.
export const checkpointToneSchema = z.enum(["success", "critical", "warning", "neutral"]);
export type CheckpointTone = z.infer<typeof checkpointToneSchema>;

export const checkpointExecutionStateSchema = z.enum([
    "not_started",
    "running",
    "stale",
    "passed",
    "failed",
    "pipeline_failed",
    "unknown",
]);
export type CheckpointExecutionState = z.infer<typeof checkpointExecutionStateSchema>;

export const checkpointTestCountsSchema = z.object({
    assigned: z.number(),
    run: z.number(),
    passed: z.number(),
    failed: z.number(),
    // Tests that never ran because their scenario setup failed.
    setupFailed: z.number(),
    running: z.number(),
    notRun: z.number(),
});
export type CheckpointTestCounts = z.infer<typeof checkpointTestCountsSchema>;

// Engine-vs-app attribution of failing tests that have a linked Issue: an
// `engine_limitation` Issue counts as engine, `application_bug` / `unknown_issue`
// as app. Replaces the former quarantine split now that reported tests re-run.
export const checkpointFailingByKindSchema = z.object({
    engine: z.number(),
    app: z.number(),
});
export type CheckpointFailingByKind = z.infer<typeof checkpointFailingByKindSchema>;

export const checkpointPresentationSummarySchema = z.object({
    tone: checkpointToneSchema,
    label: z.string(),
    reason: z.string().optional(),
    executionState: checkpointExecutionStateSchema,
    // Unique open application bugs.
    openBugCount: z.number(),
    // Raw application-issue occurrences.
    issueOccurrenceCount: z.number(),
    testCounts: checkpointTestCountsSchema,
    failingByKind: checkpointFailingByKindSchema,
    suiteChangeCount: z.number(),
});
export type CheckpointPresentationSummary = z.infer<typeof checkpointPresentationSummarySchema>;
