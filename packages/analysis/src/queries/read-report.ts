import type { Prisma, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { type AnalysisFlow, type EvidenceManifestEntry, analysisFlowSchema } from "@autonoma/types";
import { parseEvidenceManifest } from "./evidence-manifest";

/**
 * The settled report: what the Reporter AUTHORED, plus the identity of the run it authored it for. The run's
 * counts are not here - they are the findings' to answer, through {@link Analysis.planeSummary}.
 */
export interface SettledReport {
    snapshotId: string;
    branchId: string;
    /** When the report's snapshot (= run) was opened - what "is a newer run ahead of this report" compares on. */
    snapshotCreatedAt: Date;
    /** The Reporter's title for the PR, ~8 words. Absent on a row written before the Reporter authored one. */
    title?: string;
    /** The Reporter's headline: the branch's cumulative state in 1-3 plain sentences. */
    headline?: string;
    /**
     * The branch's flow itemization. Empty on a row predating it, and on one whose stored blob does not parse - a
     * partial list would understate what the PR covers, so a malformed one is dropped whole.
     */
    flows: AnalysisFlow[];
    /** The Reporter's holistic report prose (Markdown); absent on rows written before the Reporter authored one. */
    reportMarkdown?: string;
    /** The assets `reportMarkdown` embeds by token, validated; empty when absent or malformed. */
    evidenceManifest: EvidenceManifestEntry[];
    impactReasoning?: string;
}

const settledReportSelect = {
    title: true,
    headline: true,
    flows: true,
    reportMarkdown: true,
    evidenceManifest: true,
    // Prefer the job's value; the report's own column is the fallback for rows not yet backfilled onto the job.
    impactReasoning: true,
    snapshot: {
        select: { id: true, branchId: true, createdAt: true, analysisJob: { select: { impactReasoning: true } } },
    },
} satisfies Prisma.AnalysisReportSelect;

type SettledReportRow = Prisma.AnalysisReportGetPayload<{ select: typeof settledReportSelect }>;

/**
 * One analysis's settled report, or undefined while none exists - the Reporter has not run, or its result was
 * discarded. The row's mere existence means the analysis settled.
 */
export async function readSettledReport(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<SettledReport | undefined> {
    const row = await db.analysisReport.findUnique({ where: { snapshotId }, select: settledReportSelect });
    if (row == null) return undefined;
    return toSettledReport(row);
}

/** The branch's newest settled report by run open time, or undefined when no run on it ever settled. */
export async function readLatestSettledReport(
    db: PrismaClient | Prisma.TransactionClient,
    branchId: string,
): Promise<SettledReport | undefined> {
    const row = await db.analysisReport.findFirst({
        where: { snapshot: { branchId } },
        orderBy: { snapshot: { createdAt: "desc" } },
        select: settledReportSelect,
    });
    if (row == null) return undefined;
    return toSettledReport(row);
}

function toSettledReport(row: SettledReportRow): SettledReport {
    return {
        snapshotId: row.snapshot.id,
        branchId: row.snapshot.branchId,
        snapshotCreatedAt: row.snapshot.createdAt,
        flows: parseFlows(row.flows, row.snapshot.id),
        // All three prose columns are NOT NULL, but a row predating the Reporter carries "".
        title: row.title !== "" ? row.title : undefined,
        headline: row.headline !== "" ? row.headline : undefined,
        reportMarkdown: row.reportMarkdown !== "" ? row.reportMarkdown : undefined,
        evidenceManifest: parseEvidenceManifest(row.evidenceManifest),
        impactReasoning: row.snapshot.analysisJob?.impactReasoning ?? row.impactReasoning ?? undefined,
    };
}

/** Validated at the read boundary; a malformed blob is dropped whole rather than surfaced half-rendered. */
function parseFlows(flows: unknown, snapshotId: string): AnalysisFlow[] {
    if (flows == null) return [];
    const parsed = analysisFlowSchema.array().safeParse(flows);
    if (parsed.success) return parsed.data;
    rootLogger.child({ name: "readSettledReport" }).warn("Dropping a malformed flow itemization", {
        snapshot: { snapshotId },
        extra: { error: parsed.error.message },
    });
    return [];
}
