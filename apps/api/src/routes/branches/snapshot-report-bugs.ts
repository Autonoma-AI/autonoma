import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { type SnapshotReportBug, runAnalysisSchema } from "@autonoma/types";
import { findFailureStep } from "../find-failure-step";

interface RawSnapshotReportBug {
    id: string;
    title: string;
    description: string;
    severity: string;
    status: string;
    _count: { issues: number };
    issues: Array<{
        id: string;
        generationReview: {
            analysis: unknown;
            generation: {
                finalScreenshot: string | null;
                testPlan: { testCase: { slug: string } };
                outputs: {
                    _count: { list: number };
                    list: Array<{ order: number; screenshotAfter: string | null; screenshotBefore: string | null }>;
                } | null;
            };
        } | null;
        runReview: {
            analysis: unknown;
            run: {
                assignment: { testCase: { slug: string } };
                outputs: {
                    _count: { list: number };
                    list: Array<{ order: number; screenshotAfter: string | null; screenshotBefore: string | null }>;
                } | null;
            };
        } | null;
    }>;
}

function issueLinkForSnapshot(snapshotId: string) {
    return {
        OR: [
            { runReview: { run: { assignment: { snapshotId } } } },
            { generationReview: { generation: { snapshotId } } },
            { snapshotId },
        ],
    };
}

export async function loadBugsForSnapshot(
    db: PrismaClient,
    snapshotId: string,
    storageProvider: StorageProvider,
    parentLogger: Logger,
): Promise<SnapshotReportBug[]> {
    const logger = parentLogger.child({ name: "loadBugsForSnapshot" });
    const link = issueLinkForSnapshot(snapshotId);

    const bugs = await db.bug.findMany({
        where: { issues: { some: link } },
        select: {
            id: true,
            title: true,
            description: true,
            severity: true,
            status: true,
            _count: { select: { issues: true } },
            issues: {
                where: link,
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                    id: true,
                    generationReview: {
                        select: {
                            analysis: true,
                            generation: {
                                select: {
                                    finalScreenshot: true,
                                    testPlan: { select: { testCase: { select: { slug: true } } } },
                                    outputs: {
                                        select: {
                                            _count: { select: { list: true } },
                                            list: {
                                                orderBy: { order: "asc" },
                                                select: { order: true, screenshotAfter: true, screenshotBefore: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    runReview: {
                        select: {
                            analysis: true,
                            run: {
                                select: {
                                    assignment: { select: { testCase: { select: { slug: true } } } },
                                    outputs: {
                                        select: {
                                            _count: { select: { list: true } },
                                            list: {
                                                orderBy: { order: "asc" },
                                                select: { order: true, screenshotAfter: true, screenshotBefore: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    logger.info("Loaded bugs for snapshot", { snapshotId, count: bugs.length });

    return Promise.all(bugs.map((bug) => toReportBug(bug, storageProvider)));
}

async function toReportBug(bug: RawSnapshotReportBug, storageProvider: StorageProvider): Promise<SnapshotReportBug> {
    const linkingIssue = bug.issues[0];
    const run = linkingIssue?.runReview?.run;
    const generation = linkingIssue?.generationReview?.generation;
    const analysis = runAnalysisSchema.safeParse(
        linkingIssue?.runReview?.analysis ?? linkingIssue?.generationReview?.analysis,
    );
    const stepIndex = analysis.success ? analysis.data.failurePoint?.stepOrder : undefined;
    const outputs = run?.outputs ?? generation?.outputs;
    const evidenceStep = findFailureStep(outputs?.list ?? [], stepIndex);
    const screenshotKey =
        evidenceStep?.screenshotAfter ?? evidenceStep?.screenshotBefore ?? generation?.finalScreenshot ?? undefined;
    const screenshotUrl = screenshotKey != null ? await storageProvider.getSignedUrl(screenshotKey, 3600) : undefined;
    const stepTotal = outputs?._count.list;

    return {
        bugId: bug.id,
        title: bug.title,
        description: bug.description,
        severity: bug.severity,
        status: bug.status,
        occurrences: bug._count.issues,
        testSlug: run?.assignment.testCase.slug ?? generation?.testPlan.testCase.slug,
        stepIndex,
        stepTotal: stepTotal != null && stepTotal > 0 ? stepTotal : undefined,
        screenshotUrl,
        issueId: linkingIssue?.id,
    };
}
