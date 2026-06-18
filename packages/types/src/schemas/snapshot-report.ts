import { z } from "zod";

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

export const snapshotReportSelectedTestSchema = z.object({
    testCaseId: z.string(),
    name: z.string(),
    slug: z.string(),
    affectedReason: z.string().optional(),
    reasoning: z.string().optional(),
});
export type SnapshotReportSelectedTest = z.infer<typeof snapshotReportSelectedTestSchema>;

export const snapshotReportSelectionSchema = z.object({
    totalSuiteTests: z.number(),
    selected: z.array(snapshotReportSelectedTestSchema),
    analysisReasoning: z.string().optional(),
});

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

export const snapshotReportBugSchema = z.object({
    bugId: z.string(),
    title: z.string(),
    description: z.string(),
    severity: z.string(),
    status: z.string(),
    occurrences: z.number(),
    testSlug: z.string().optional(),
    stepIndex: z.number().optional(),
    stepTotal: z.number().optional(),
    screenshotUrl: z.string().optional(),
    issueId: z.string().optional(),
});
export type SnapshotReportBug = z.infer<typeof snapshotReportBugSchema>;

export const snapshotReportHealthCountsSchema = z.object({
    failing: z.number(),
    passing: z.number(),
    running: z.number(),
    setupFailed: z.number(),
    quarantined: z.number(),
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
    selection: snapshotReportSelectionSchema,
    results: snapshotReportResultsSchema,
    bugs: z.array(snapshotReportBugSchema),
    firstIterationReasoning: z.string().optional(),
    health: reportHealthSchema,
    healthCounts: snapshotReportHealthCountsSchema,
});
export type SnapshotReport = z.infer<typeof snapshotReportSchema>;
