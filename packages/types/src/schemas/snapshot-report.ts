import { z } from "zod";
import { checkpointPresentationSummarySchema } from "./checkpoint-summary";

export const reportHealthSchema = z.enum(["healthy", "critical", "running", "unknown"]);

export const reportTestStatusSchema = z.enum(["passed", "failed", "setup_failed", "running", "pending"]);
export type ReportTestStatus = z.infer<typeof reportTestStatusSchema>;

export const reportCommitFileSchema = z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
});

export const snapshotReportTriggerSchema = z.object({
    headSha: z.string().optional(),
    baseSha: z.string().optional(),
    source: z.string(),
    createdAt: z.date(),
    commit: z.object({ message: z.string(), authorLogin: z.string().optional() }).optional(),
    filesChanged: z.array(reportCommitFileSchema),
    filesChangedTruncated: z.boolean(),
});
export type SnapshotReportTrigger = z.infer<typeof snapshotReportTriggerSchema>;

export const snapshotReportTestResultSchema = z.object({
    testCaseId: z.string(),
    name: z.string(),
    slug: z.string(),
    status: reportTestStatusSchema,
    runId: z.string().optional(),
    durationMs: z.number().optional(),
});
export type SnapshotReportTestResult = z.infer<typeof snapshotReportTestResultSchema>;

export const snapshotReportResultsSchema = z.object({
    durationMs: z.number().optional(),
    passed: z.number(),
    failed: z.number(),
    setupFailed: z.number(),
    pending: z.number(),
    running: z.number(),
    total: z.number(),
    tests: z.array(snapshotReportTestResultSchema),
});
export type SnapshotReportResults = z.infer<typeof snapshotReportResultsSchema>;

export const snapshotReportHealthCountsSchema = z.object({
    failing: z.number(),
    passing: z.number(),
    running: z.number(),
    setupFailed: z.number(),
    notAffected: z.number(),
    totalTests: z.number(),
});

export const snapshotReportSchema = z.object({
    snapshot: z.object({
        id: z.string(),
        status: z.string(),
        source: z.string(),
        headSha: z.string().optional(),
        baseSha: z.string().optional(),
        createdAt: z.date(),
        branch: z.object({ id: z.string(), name: z.string(), prNumber: z.number().optional() }),
    }),
    trigger: snapshotReportTriggerSchema,
    results: snapshotReportResultsSchema,
    health: reportHealthSchema,
    healthCounts: snapshotReportHealthCountsSchema,
    summary: checkpointPresentationSummarySchema.optional(),
});
export type SnapshotReport = z.infer<typeof snapshotReportSchema>;
