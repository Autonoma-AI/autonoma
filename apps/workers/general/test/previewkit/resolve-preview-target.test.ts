import { ApplicationArchitecture, createClient, type PrismaClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { resolvePreviewTarget } from "../../src/activities/previewkit/resolve-preview-target";

// The activity reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so it and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

/** Monotonic counter for unique names across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface SeedOptions {
    /** How the app gets its previews. `previewkit` is the path that owns a target. */
    previewEnvironmentMode: "previewkit" | "existing_deploys";
    /** Where onboarding is parked. `completed` means the app is live. */
    step: "previewkit_configuring" | "completed";
}

class PreviewTargetHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<PreviewTargetHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new PreviewTargetHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /**
     * A PR branch on a repo-linked application, plus an existing preview environment for that repo.
     *
     * The environment is what lets `resolveRepoFullName` answer from the database instead of reaching GitHub, which
     * is the only thing in this activity that would need a network.
     */
    async seedPrBranch(options: SeedOptions): Promise<string> {
        const n = next();
        const githubRepositoryId = 900_000 + n;
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
                githubRepositoryId,
                onboardingState: {
                    create: {
                        step: options.step,
                        previewEnvironmentMode: options.previewEnvironmentMode,
                        completedAt: options.step === "completed" ? new Date() : undefined,
                    },
                },
            },
        });
        const branch = await this.db.branch.create({
            data: {
                name: `feature/${n}`,
                applicationId: app.id,
                organizationId: org.id,
                prInfo: { create: { applicationId: app.id, prNumber: n + 1, prState: "open" } },
            },
        });

        await this.db.previewkitEnvironment.create({
            data: {
                namespace: `preview-${n}`,
                repoFullName: `acme/repo-${n}`,
                prNumber: n + 1,
                headSha: `head-${n}`,
                headRef: `feature/${n}`,
                organizationId: org.id,
                githubRepositoryId,
                status: "ready",
            },
        });

        return branch.id;
    }
}

integrationTestSuite({
    name: "resolvePreviewTarget (the run's view of who owns the preview)",
    createHarness: () => PreviewTargetHarness.create(),
    cases: (test) => {
        // The regression this file exists for: the previewkit exit used to omit `onboardingComplete`, so the
        // workflow's `=== false` check never fired and every PR took the `onboarding_incomplete` build exemption.
        test("reports an unfinished onboarding on the previewkit path", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "previewkit_configuring",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeDefined();
            expect(resolved.onboardingComplete).toBe(false);
        });

        test("reports a finished onboarding on the previewkit path", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "previewkit",
                step: "completed",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeDefined();
            expect(resolved.onboardingComplete).toBe(true);
        });

        test("reports onboarding on the customer-deployed path, where the run owns no preview", async ({ harness }) => {
            const branchId = await harness.seedPrBranch({
                previewEnvironmentMode: "existing_deploys",
                step: "previewkit_configuring",
            });

            const resolved = await resolvePreviewTarget({ branchId, headSha: "abc123" });

            expect(resolved.target).toBeUndefined();
            expect(resolved.onboardingComplete).toBe(false);
        });
    },
});
