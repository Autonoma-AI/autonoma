import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV3 } from "ai/test";
import { type TestAPI, expect } from "vitest";
import { BugMatcher } from "../src/healing/bug-matcher";

const POSTGRES_IMAGE = "postgres:17-alpine";

let seq = 0;
const next = () => seq++;

/** A model that returns a fixed dedup verdict as structured JSON. */
function verdictModel(result: { matchedBugId: string | null; reasoning: string }): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text: JSON.stringify(result) }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

/** A tripwire model: fails the test if the matcher consults it at all. */
function tripwireModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => {
            throw new Error("BugMatcher consulted the model when it should have short-circuited");
        },
    });
}

class BugMatcherHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<BugMatcherHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        return new BugMatcherHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await stopContainer(this.pg);
    }
    async beforeEach() {}
    async afterEach() {}

    async createOrgAndApp(): Promise<{ organizationId: string; applicationId: string }> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}`, organizationId: org.id, architecture: "WEB" },
        });
        return { organizationId: org.id, applicationId: app.id };
    }

    async createBranch(organizationId: string, applicationId: string): Promise<string> {
        const branch = await this.db.branch.create({
            data: { name: `branch-${next()}`, organizationId, applicationId },
        });
        return branch.id;
    }

    async createBug(args: {
        organizationId: string;
        applicationId: string;
        branchId: string;
        title: string;
        description: string;
    }): Promise<string> {
        const bug = await this.db.bug.create({
            data: {
                title: args.title,
                description: args.description,
                severity: "high",
                branchId: args.branchId,
                applicationId: args.applicationId,
                organizationId: args.organizationId,
            },
            select: { id: true },
        });
        return bug.id;
    }
}

interface Seed {
    organizationId: string;
    applicationId: string;
}

type SuiteContext = { harness: BugMatcherHarness; seedResult: Seed };

function bugMatcherSuite(cases: (test: TestAPI<SuiteContext>) => void) {
    integrationTestSuite<BugMatcherHarness, Seed>({
        name: "BugMatcher branch scoping",
        createHarness: () => BugMatcherHarness.create(),
        seed: (harness) => harness.createOrgAndApp(),
        cases,
    });
}

bugMatcherSuite((test) => {
    test("a candidate on branch B never sees a bug tracked on branch A (two branches, two bugs)", async ({
        harness,
        seedResult: { organizationId, applicationId },
    }) => {
        const branchA = await harness.createBranch(organizationId, applicationId);
        const branchB = await harness.createBranch(organizationId, applicationId);

        // The only existing bug lives on branch A.
        await harness.createBug({
            organizationId,
            applicationId,
            branchId: branchA,
            title: "Login button unresponsive",
            description: "Clicking Sign In does nothing.",
        });

        // The matcher for branch B must treat the candidate as novel and never even
        // consult the model, because branch B has no bugs of its own. A shared
        // application scope would have surfaced branch A's bug here.
        const model = tripwireModel();
        const matcher = new BugMatcher(harness.db, branchB, model);

        const match = await matcher.findMatch({
            title: "Cannot click Sign In",
            description: "The login button appears dead.",
        });

        expect(match).toBeUndefined();
        expect(model.doGenerateCalls).toHaveLength(0);
    });

    test("a candidate on the same branch is matched against that branch's bugs", async ({
        harness,
        seedResult: { organizationId, applicationId },
    }) => {
        const branchA = await harness.createBranch(organizationId, applicationId);
        const bugId = await harness.createBug({
            organizationId,
            applicationId,
            branchId: branchA,
            title: "Login button unresponsive",
            description: "Clicking Sign In does nothing.",
        });

        const matcher = new BugMatcher(
            harness.db,
            branchA,
            verdictModel({ matchedBugId: bugId, reasoning: "same root cause" }),
        );

        const match = await matcher.findMatch({
            title: "Cannot click Sign In",
            description: "The login button appears dead.",
        });

        expect(match).toBe(bugId);
    });
});
