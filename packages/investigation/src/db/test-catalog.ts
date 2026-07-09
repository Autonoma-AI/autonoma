import type { PrismaClient } from "@autonoma/db";
import { planSummary } from "../plan-summary";

/** A test case as the selector sees it (to decide which tests a diff affects). */
export interface TestCaseInfo {
    slug: string;
    name: string;
    flow: string;
    /** A one-line summary from the plan frontmatter (description/intent) - the progressive-disclosure layer. */
    description: string;
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
     * The tests assigned to one snapshot - the candidate set the selector chooses from - grouped by flow.
     * Quarantined and plan-less assignments are excluded (not runnable tests); the description comes from each
     * assignment's PINNED plan, not a test case's latest plan.
     *
     * `createdBefore` (the snapshot's own createdAt) applies a BASE-RELATIVE cutoff: a detached investigation
     * twin is NOT a frozen pre-PR baseline in practice - the deployed diffs agent creates tests for the SAME PR
     * and they get assigned onto the twin AFTER the fork (verified in prod: same-PR tests whose createdAt is
     * minutes after the snapshot's). Considering those would leak the deployed agent's own same-PR work into our
     * independent selection - it would make us "already covered" for behavior we should be proposing a test for.
     * So we drop every test case created at/after the snapshot, leaving the genuine pre-PR suite. Omit the arg
     * (e.g. in unit tests) to skip the cutoff.
     *
     * The cutoff is on `testCase.createdAt`, NOT `TestCaseAssignment.createdAt`, deliberately: the fork copies
     * the baseline assignments with `createMany` (create-branch-snapshot.ts), which restamps every copied row's
     * `createdAt` to fork time (~= the snapshot's createdAt) - so an assignment-time cutoff would drop the whole
     * pre-PR suite along with the leaks. The pinned `plan` read below is the plan the assignment captured at
     * fork (never re-pointed to a post-PR plan on the detached twin), so the description can't be re-contaminated
     * by a same-PR plan edit even for a pre-PR test case.
     */
    async listSnapshotTestCases(snapshotId: string, createdBefore?: Date): Promise<TestCaseInfo[]> {
        const assignments = await this.db.testCaseAssignment.findMany({
            where: {
                snapshotId,
                quarantineIssueId: null,
                planId: { not: null },
                testCase: createdBefore != null ? { createdAt: { lt: createdBefore } } : undefined,
            },
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
