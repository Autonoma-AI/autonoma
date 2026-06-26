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
     * Every test case for an application, grouped by flow (folder) - the catalog the selector chooses from.
     * `createdBefore` scopes to tests that existed before that time (the PR snapshot): this EXCLUDES tests
     * the deployed agent just created FOR this PR, keeping our selection independent for a fair comparison.
     */
    async listTestCases(applicationId: string, createdBefore?: Date): Promise<TestCaseInfo[]> {
        const testCases = await this.db.testCase.findMany({
            where: { applicationId, createdAt: createdBefore != null ? { lt: createdBefore } : undefined },
            select: {
                slug: true,
                name: true,
                folder: { select: { name: true } },
                plans: { select: { prompt: true }, orderBy: { createdAt: "desc" }, take: 1 },
            },
            orderBy: [{ folder: { name: "asc" } }, { name: "asc" }],
        });
        return testCases.map((testCase) => ({
            slug: testCase.slug,
            name: testCase.name,
            flow: testCase.folder.name,
            description: planSummary(testCase.plans[0]?.prompt),
        }));
    }

    /** The latest test plan prompt for one test case (the instruction the browser agent runs), if any. */
    async getLatestPlan(applicationId: string, testSlug: string): Promise<string | undefined> {
        const testCase = await this.db.testCase.findFirst({
            where: { applicationId, slug: testSlug },
            select: { plans: { select: { prompt: true }, orderBy: { createdAt: "desc" }, take: 1 } },
        });
        return testCase?.plans[0]?.prompt;
    }
}
