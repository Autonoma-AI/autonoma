import type { PrismaClient } from "@autonoma/db";

/** The currently-deployed agent's (the k8s "diffs" agent) outcome for one test on a PR snapshot. */
export interface DeployedTestResult {
    testSlug: string;
    affectedReason?: string;
    runStatus?: string;
    generatedFix: boolean;
    reasoning?: string;
}

/** The deployed agent's full result for a PR snapshot - for side-by-side comparison with our verdicts. */
export interface DeployedAgentComparison {
    found: boolean;
    jobStatus?: string;
    /** The deployed agent's human-readable conclusion from analysis (which tests it flagged + why). */
    analysisReasoning?: string;
    /** Its human-readable resolution summary (what it changed in the tests). */
    resolutionReasoning?: string;
    failureReason?: string;
    /** S3 URLs of the deployed agent's raw conversation logs. */
    analysisConversationUrl?: string;
    resolutionConversationUrl?: string;
    perTest: DeployedTestResult[];
}

// NOTE: resolutionConversationUrl is intentionally NOT selected - that column isn't migrated to every env
// yet, and selecting a missing column makes the whole query throw (which previously degraded the comparison
// to a false "no run found"). It's only an optional display link; re-add it once the migration is applied.
const DIFFS_JOB_SELECT = {
    status: true,
    analysisReasoning: true,
    resolutionReasoning: true,
    failureReason: true,
    analysisConversationUrl: true,
    affectedTests: {
        select: {
            affectedReason: true,
            reasoning: true,
            generationId: true,
            testCase: { select: { slug: true } },
            run: { select: { status: true } },
        },
    },
} as const;

type DiffsJobShape = {
    status: string;
    analysisReasoning: string | null;
    resolutionReasoning: string | null;
    failureReason: string | null;
    analysisConversationUrl: string | null;
    affectedTests: Array<{
        affectedReason: string;
        reasoning: string | null;
        generationId: string | null;
        testCase: { slug: string };
        run: { status: string } | null;
    }>;
};

const NOT_FOUND: DeployedAgentComparison = { found: false, perTest: [] };

/** Reads the currently-deployed ("diffs") agent's result for a PR snapshot, for side-by-side comparison. */
export class DeployedComparison {
    constructor(private readonly db: PrismaClient) {}

    /** The deployed agent's result for the snapshot at this exact head SHA (precise; used by the live path). */
    async byHeadSha(headSha: string): Promise<DeployedAgentComparison> {
        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { headSha },
            select: { diffsJob: { select: DIFFS_JOB_SELECT } },
        });
        return DeployedComparison.toComparison(snapshot?.diffsJob);
    }

    /**
     * The deployed agent's result resolved by (app, PR) - the latest snapshot the deployed agent actually
     * ran a DiffsJob on. Used when we don't have the exact head SHA (e.g. backfill).
     */
    async byPr(appSlug: string, prNumber: number): Promise<DeployedAgentComparison> {
        // NOTE: slug is unique only per-organization, so resolve with findFirst (matches the prototype's
        // global-slug lookup). See the known app-slug-collides-across-orgs caveat if this ever onboards
        // an internal-org dogfood app.
        const application = await this.db.application.findFirst({ where: { slug: appSlug }, select: { id: true } });
        if (application == null) return NOT_FOUND;

        const featureBranch = await this.db.featureBranchInfo.findFirst({
            where: { applicationId: application.id, prNumber },
            select: { branchId: true },
        });
        if (featureBranch == null) return NOT_FOUND;

        const snapshot = await this.db.branchSnapshot.findFirst({
            where: { branchId: featureBranch.branchId, diffsJob: { isNot: null } },
            orderBy: { createdAt: "desc" },
            select: { diffsJob: { select: DIFFS_JOB_SELECT } },
        });
        return DeployedComparison.toComparison(snapshot?.diffsJob);
    }

    private static toComparison(diffsJob: DiffsJobShape | null | undefined): DeployedAgentComparison {
        if (diffsJob == null) return NOT_FOUND;
        return {
            found: true,
            jobStatus: diffsJob.status,
            analysisReasoning: diffsJob.analysisReasoning ?? undefined,
            resolutionReasoning: diffsJob.resolutionReasoning ?? undefined,
            failureReason: diffsJob.failureReason ?? undefined,
            analysisConversationUrl: diffsJob.analysisConversationUrl ?? undefined,
            perTest: diffsJob.affectedTests.map((affectedTest) => ({
                testSlug: affectedTest.testCase.slug,
                affectedReason: affectedTest.affectedReason,
                runStatus: affectedTest.run?.status ?? undefined,
                generatedFix: affectedTest.generationId != null,
                reasoning: affectedTest.reasoning ?? undefined,
            })),
        };
    }
}
