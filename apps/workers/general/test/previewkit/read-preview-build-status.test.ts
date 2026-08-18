import {
    ApplicationArchitecture,
    createClient,
    type PreviewkitStatus,
    type PrismaClient,
    previewkitConfigCreateChildren,
    PreviewkitAppStatus,
} from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { type PreviewDeployTarget, previewkitConfigRowValues, trustedPreviewConfigSchema } from "@autonoma/types";
import { expect } from "vitest";
import { previewBuildRefusalReason } from "../../src/activities/previewkit/preview-build-refusal-reason";
import { readPreviewBuildStatus } from "../../src/activities/previewkit/read-preview-build-status";

// The activity reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so it and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const OUR_SHA = "sha-ours";
const PREVIOUS_SHA = "sha-previous";
const NEWER_SHA = "sha-newer";

const WEB_URL = "https://web.preview.example.com";
const API_URL = "https://api.preview.example.com";

/** A config `previewConfigSchema` accepts, declaring a browsed primary app and a separate SDK host. */
const RESOLVED_CONFIG = {
    version: 2,
    apps: [
        { name: "web", repository: "acme/web", port: 3000, primary: true },
        { name: "api", repository: "acme/web", port: 4000, sdk_implemented: true },
    ],
};

/** Monotonic counter for unique names across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface SeedInput {
    headSha: string;
    status: PreviewkitStatus;
    urls?: Record<string, string>;
    error?: string;
    /** Per-app rows, when a test needs one app to have failed while its siblings came up. */
    appInstances?: { appName: string; status: PreviewkitAppStatus; url?: string }[];
}

class PreviewBuildStatusHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<PreviewBuildStatusHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new PreviewBuildStatusHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** A (repo, PR) with no environment row at all - the very first build on a branch. */
    unseededEnvironment(): { repoFullName: string; prNumber: number } {
        const n = next();
        return { repoFullName: `acme/repo-${n}`, prNumber: n + 1 };
    }

    async seedEnvironment(input: SeedInput): Promise<{ repoFullName: string; prNumber: number }> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const repoFullName = `acme/repo-${n}`;
        const prNumber = n + 1;
        const githubRepositoryId = 2_000 + n;

        // An app instance hangs off an app row, so the fixture needs the application
        // and topology its apps belong to, not just the environment.
        const appIds = new Map<string, string>();
        if (input.appInstances != null) {
            const application = await this.db.application.create({
                data: {
                    name: `App ${n}`,
                    slug: `app-env-${n}`,
                    architecture: ApplicationArchitecture.WEB,
                    organizationId: org.id,
                    githubRepositoryId,
                },
            });
            const config = await this.db.previewkitConfig.create({
                data: { applicationId: application.id },
                select: { id: true },
            });
            for (const [position, app] of input.appInstances.entries()) {
                const row = await this.db.previewkitApp.create({
                    data: {
                        configId: config.id,
                        position,
                        name: app.appName,
                        repository: repoFullName,
                        path: ".",
                        port: 3000,
                        resourcesCpu: "250m",
                        resourcesMemoryRequest: "512Mi",
                        resourcesMemoryLimit: "1Gi",
                    },
                    select: { id: true },
                });
                appIds.set(app.appName, row.id);
            }
        }

        await this.db.previewkitEnvironment.create({
            data: {
                namespace: `preview-${n}`,
                repoFullName,
                prNumber,
                headSha: input.headSha,
                headRef: `feature/${n}`,
                organizationId: org.id,
                githubRepositoryId,
                status: input.status,
                urls: input.urls ?? {},
                resolvedConfig: RESOLVED_CONFIG,
                error: input.error ?? null,
                ...(input.appInstances != null
                    ? {
                          appInstances: {
                              create: input.appInstances.map((app) => ({
                                  appName: app.appName,
                                  appId: appIds.get(app.appName)!,
                                  status: app.status,
                                  url: app.url ?? null,
                                  port: 3000,
                              })),
                          },
                      }
                    : {}),
            },
        });

        return { repoFullName, prNumber };
    }

    /** An Application the runner can resolve: linked to the target's repository id, and carrying a preview config. */
    async seedDeployableTarget(): Promise<PreviewDeployTarget> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const githubRepositoryId = 1_000 + n;
        const application = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                architecture: ApplicationArchitecture.WEB,
                organizationId: org.id,
                githubRepositoryId,
            },
        });
        await this.db.previewkitConfig.create({
            data: {
                applicationId: application.id,
                ...previewkitConfigCreateChildren(
                    previewkitConfigRowValues(trustedPreviewConfigSchema.parse(RESOLVED_CONFIG)),
                ),
            },
        });

        return {
            repoFullName: `acme/repo-${n}`,
            prNumber: n + 1,
            organizationId: org.id,
            githubRepositoryId,
            headSha: OUR_SHA,
            headRef: `feature/${n}`,
        };
    }
}

integrationTestSuite({
    name: "readPreviewBuildStatus + previewBuildRefusalReason (the orchestrator's database reads)",
    createHarness: () => PreviewBuildStatusHarness.create(),
    cases: (test) => {
        const poll = (env: { repoFullName: string; prNumber: number }) =>
            readPreviewBuildStatus({ ...env, headSha: OUR_SHA });

        /**
         * The only direction worth guarding: an over-broad refusal silently stops building previews for every
         * working customer, and no other test exercises this lookup against a real compound-key row.
         */
        test("does not refuse a repository whose application carries a preview config", async ({ harness }) => {
            const target = await harness.seedDeployableTarget();

            expect(await previewBuildRefusalReason(target)).toBeUndefined();
        });

        test("reads as missing before the build writes its first row", async ({ harness }) => {
            expect(await poll(harness.unseededEnvironment())).toEqual({ state: "missing" });
        });

        /**
         * The environment row is shared per (repo, PR) and the runner stamps our head on it only at the END of its
         * prepare phase. Reading the leftover head as a verdict failed every push to an established preview.
         */
        test("keeps waiting while the row still carries the previous deploy's head", async ({ harness }) => {
            const env = await harness.seedEnvironment({ headSha: PREVIOUS_SHA, status: "ready" });

            expect(await poll(env)).toEqual({ state: "missing" });
        });

        /**
         * Even a plainly NEWER head is only "not ours yet", and never needs to be more: that push starts the run
         * under the same workflow id with terminate-existing, so it has already killed us.
         */
        test("keeps waiting rather than guessing at a supersede when the row is at another head", async ({
            harness,
        }) => {
            const env = await harness.seedEnvironment({ headSha: NEWER_SHA, status: "building" });

            expect(await poll(env)).toEqual({ state: "missing" });
        });

        test("reads as building once our own build has claimed the environment", async ({ harness }) => {
            const env = await harness.seedEnvironment({ headSha: OUR_SHA, status: "deploying" });

            expect(await poll(env)).toEqual({ state: "building" });
        });

        test("reads as ready with the primary and SDK origins once the preview is up", async ({ harness }) => {
            const env = await harness.seedEnvironment({
                headSha: OUR_SHA,
                status: "ready",
                urls: { web: WEB_URL, api: API_URL },
            });

            expect(await poll(env)).toEqual({ state: "ready", primaryUrl: WEB_URL, sdkAppUrl: API_URL });
        });

        // `ready` with the browsed app failed: the read has to name the cause or it reads downstream as a riddle.
        test("explains a missing primary URL by naming the app that failed to build", async ({ harness }) => {
            const env = await harness.seedEnvironment({
                headSha: OUR_SHA,
                status: "ready",
                // The primary app never produced a URL; its backend sibling did.
                urls: { api: API_URL },
                appInstances: [
                    { appName: "web", status: PreviewkitAppStatus.build_failed },
                    { appName: "api", status: PreviewkitAppStatus.ready },
                ],
            });

            const status = await poll(env);

            expect(status.state).toBe("ready");
            // Never a sibling's URL: browsing the API because the frontend failed produces false findings.
            expect(status.primaryUrl).toBeUndefined();
            expect(status.error).toContain("web");
            expect(status.error).toContain("build failed");
        });

        // The blob carries an entry for every app not SKIPPED, so a failed deploy leaves a dead hostname behind.
        test("ignores the stored URL of a primary app that deployed and failed", async ({ harness }) => {
            const env = await harness.seedEnvironment({
                headSha: OUR_SHA,
                status: "ready",
                urls: { web: WEB_URL, api: API_URL },
                appInstances: [
                    { appName: "web", status: PreviewkitAppStatus.deploy_failed, url: WEB_URL },
                    { appName: "api", status: PreviewkitAppStatus.ready, url: API_URL },
                ],
            });

            const status = await poll(env);

            expect(status.state).toBe("ready");
            expect(status.primaryUrl).toBeUndefined();
            expect(status.error).toContain("web");
            expect(status.error).toContain("deploy failed");
        });

        // Rows predating the per-app lifecycle table: the blob is all there is, so it is trusted unfiltered.
        test("falls back to the stored URLs when an environment has no per-app rows", async ({ harness }) => {
            const env = await harness.seedEnvironment({
                headSha: OUR_SHA,
                status: "ready",
                urls: { web: WEB_URL, api: API_URL },
            });

            expect(await poll(env)).toEqual({ state: "ready", primaryUrl: WEB_URL, sdkAppUrl: API_URL });
        });

        test("reads as failed, carrying the environment's error", async ({ harness }) => {
            const env = await harness.seedEnvironment({
                headSha: OUR_SHA,
                status: "failed",
                error: "app build failed",
            });

            expect(await poll(env)).toEqual({ state: "failed", error: "app build failed" });
        });

        // The PR closed mid-build: the namespace is gone, so no preview is coming and the waiter must not hang.
        test("reads a torn-down environment as failed", async ({ harness }) => {
            const env = await harness.seedEnvironment({ headSha: OUR_SHA, status: "torn_down" });

            expect(await poll(env)).toEqual({ state: "failed" });
        });
    },
});
