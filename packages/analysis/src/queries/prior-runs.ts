import type { PrismaClient } from "@autonoma/db";
import { ANALYSIS_VERDICT } from "@autonoma/types";

/** How far back the recent window reaches. */
const MAX_RECENT_RUNS = 30;

export interface PriorRun {
    day: string;
    /** Not the verdict enum: historical rows carry retired category names. */
    category: string;
}

export interface PriorRunsHistory {
    /**
     * Whether the test has EVER been judged `passed`, over its whole history rather than the recent window.
     * It gets its own query: derived from the window, a test that passed 31 runs ago reads as never having
     * passed, and the classifier turns that into "do not blame the PR".
     */
    everPassed: boolean;
    totalRecent: number;
    passedCount: number;
    /** Day (YYYY-MM-DD), over the whole history rather than the recent window. */
    mostRecentPassDay?: string;
    /** Newest first. */
    recent: PriorRun[];
}

export interface PriorRunsQuery {
    applicationId: string;
    testSlug: string;
    /**
     * The snapshot under analysis. Excluded, not merely time-bounded: on a self-heal re-run its finding
     * already exists carrying the earlier iteration's verdict, so no `before` keeps the run being judged from
     * supplying the evidence that judges it.
     */
    currentSnapshotId: string;
    /**
     * Bounds the history to the analyses that existed at a past instant. Production omits it - now is the
     * bound - and it is passed only when freezing a baseline for later replay, where runs analyzed after the
     * frozen classification would otherwise leak into `everPassed` and `mostRecentPassDay`.
     */
    before?: Date;
}

/**
 * A test's verdict history across the application's past analyses.
 *
 * Read from the classifier's own record, not `TestGeneration.status`: a generation's status says the engine
 * finished, and a `success` generation is routinely an `engine_artifact`, an `environment_failure` or a
 * `client_bug` - a baseline built on it asserts the app behaved on evidence that says nothing about the app.
 * Resolving through `currentClassificationId` also keeps a self-heal from voting twice, since its superseded
 * iterations stay on disk as audit records.
 *
 * Keyed on `applicationId` because an app SLUG is not an identity - `Application` is unique on
 * `[slug, organizationId]`, so keying on the slug would let another tenant's passes establish `everPassed`.
 */
export async function readPriorRuns(
    db: PrismaClient,
    { applicationId, testSlug, currentSnapshotId, before }: PriorRunsQuery,
): Promise<PriorRunsHistory> {
    const scope = {
        testCase: { slug: testSlug, applicationId },
        reportSnapshotId: { not: currentSnapshotId },
        // A finding with no current classification was never judged - it is not a prior verdict. A contained
        // finding is deliberately no prior evidence either way.
        currentClassificationId: { not: null },
        createdAt: before != null ? { lt: before } : undefined,
    };
    const [findings, lastPass] = await Promise.all([
        db.analysisFinding.findMany({
            where: scope,
            select: { createdAt: true, currentClassification: { select: { category: true } } },
            orderBy: { createdAt: "desc" },
            take: MAX_RECENT_RUNS,
        }),
        db.analysisFinding.findFirst({
            where: { ...scope, currentClassification: { category: ANALYSIS_VERDICT.passed } },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
        }),
    ]);

    const recent: PriorRun[] = findings.flatMap((finding) =>
        finding.currentClassification == null
            ? []
            : [{ day: dayOf(finding.createdAt), category: finding.currentClassification.category }],
    );

    const passes = recent.filter((run) => run.category === ANALYSIS_VERDICT.passed);
    return {
        everPassed: lastPass != null,
        totalRecent: recent.length,
        passedCount: passes.length,
        mostRecentPassDay: lastPass != null ? dayOf(lastPass.createdAt) : undefined,
        recent,
    };
}

function dayOf(at: Date): string {
    return at.toISOString().slice(0, 10);
}
