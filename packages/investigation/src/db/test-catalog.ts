import type { PrismaClient } from "@autonoma/db";

/** A test case as the selector sees it (to decide which tests a diff affects). */
export interface TestCaseInfo {
    slug: string;
    name: string;
    flow: string;
    /** A one-line summary from the plan frontmatter (description/intent) - the progressive-disclosure layer. */
    description: string;
}

/** Pull a one-line summary from a test plan's YAML frontmatter (description + intent), for the catalog view. */
function planSummary(prompt: string | undefined): string {
    if (prompt == null) return "(no plan)";
    const description = prompt.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const intent = prompt.match(/^intent:\s*["']?(.+?)["']?\s*$/m)?.[1];
    const summary = [description, intent].filter((part) => part != null && part !== "").join(" - ");
    return summary !== "" ? summary : "(no description)";
}

/** Reads an application's test catalog + plans. Replaces the prototype's raw psql test-metadata queries. */
export class TestCatalog {
    constructor(private readonly db: PrismaClient) {}

    /** Resolve an application's id from its slug (slug is unique only per-org, so findFirst). */
    async resolveApplicationId(appSlug: string): Promise<string | undefined> {
        const application = await this.db.application.findFirst({ where: { slug: appSlug }, select: { id: true } });
        return application?.id;
    }

    /**
     * The tests assigned to one snapshot - the branch's own pinned copy of the suite - grouped by flow, the
     * candidate set the selector chooses from. A snapshot is a frozen baseline, so its assignment set IS the
     * pre-PR suite (no time cutoff needed). Quarantined and plan-less assignments are excluded: they are not
     * runnable tests. The description comes from each assignment's PINNED plan, not a test case's latest plan.
     */
    async listSnapshotTestCases(snapshotId: string): Promise<TestCaseInfo[]> {
        const assignments = await this.db.testCaseAssignment.findMany({
            where: { snapshotId, quarantineIssueId: null, planId: { not: null } },
            select: {
                testCase: { select: { slug: true, name: true, folder: { select: { name: true } } } },
                plan: { select: { prompt: true } },
            },
        });
        return assignments
            .map((assignment) => ({
                slug: assignment.testCase.slug,
                name: assignment.testCase.name,
                flow: assignment.testCase.folder.name,
                description: planSummary(assignment.plan?.prompt ?? undefined),
            }))
            .sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name));
    }

    /**
     * The pinned plan prompt for one test on a snapshot (the instruction the browser agent runs), if any.
     * Reads the assignment's pinned plan - the baseline the snapshot captured - not the test case's latest plan.
     */
    async getSnapshotPlan(snapshotId: string, testSlug: string): Promise<string | undefined> {
        const assignment = await this.db.testCaseAssignment.findFirst({
            where: { snapshotId, testCase: { slug: testSlug } },
            select: { plan: { select: { prompt: true } } },
        });
        return assignment?.plan?.prompt ?? undefined;
    }

    /**
     * Resolve the runnable pinned plan for one test on a snapshot: the assignment's pinned `planId` and the
     * scenario that plan needs. Returns `undefined` when the test is not assigned to the snapshot, is
     * quarantined, or has no pinned plan (not a runnable test).
     */
    async resolveSnapshotPlan(
        snapshotId: string,
        testSlug: string,
    ): Promise<{ planId: string; scenarioId?: string } | undefined> {
        const assignment = await this.db.testCaseAssignment.findFirst({
            where: { snapshotId, testCase: { slug: testSlug }, quarantineIssueId: null },
            select: { planId: true, plan: { select: { scenarioId: true } } },
        });
        if (assignment?.planId == null) return undefined;
        return { planId: assignment.planId, scenarioId: assignment.plan?.scenarioId ?? undefined };
    }
}
