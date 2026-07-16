import { integrationTestSuite } from "@autonoma/integration-test";
import { EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import { expect, vi } from "vitest";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import { OnboardingTestHarness } from "./onboarding-harness";

vi.mock("@autonoma/workflow", () => ({
    triggerRefinementLoop: vi.fn(async () => undefined),
}));

const fakeScenarioManager = {
    discoverWithConfig: async () => ({ models: [] }),
} as unknown as ScenarioManager;
const fakeEncryption = new EncryptionHelper("0".repeat(64));

interface FakeRepo {
    id: number;
    name: string;
    fullName: string;
    defaultBranch: string;
}

/** Narrow in-memory stand-ins for the GitHub + Applications services the manager consumes. */
function buildTopologyServices(harness: OnboardingTestHarness, orgId: string, repos: FakeRepo[]) {
    const github = {
        listRepositories: vi.fn(async () => repos),
        linkRepository: vi.fn(async (organizationId: string, applicationId: string, githubRepoId: number) => {
            await harness.db.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId: githubRepoId },
            });
            void organizationId;
        }),
    };
    const applications = {
        createMinimalApplication: vi.fn(async (_name: string, organizationId: string) => ({
            id: await harness.createApp(organizationId),
        })),
    };
    void orgId;
    return { github, applications };
}

integrationTestSuite({
    name: "PreviewKit topology onboarding",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption);
        return { orgId, manager, createApp: () => harness.createApp(orgId) };
    },
    cases: (test) => {
        test("validatePreviewkitConfig returns schema issues as data with field paths", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_001);

            const result = await manager.validatePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [{ name: "web", path: "." }],
            });

            expect(result.valid).toBe(false);
            const portIssue = result.issues.find((issue) => issue.path.join(".") === "apps.0.port");
            expect(portIssue).toMatchObject({ severity: "error", code: "schema" });
        });

        test("validatePreviewkitConfig flags semantic errors and warnings", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_002);

            const invalid = await manager.validatePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [
                    { name: "web", path: ".", port: 3000, primary: true, depends_on: ["ghost"] },
                    { name: "api", path: "apps/api", port: 4000, primary: true },
                ],
            });

            expect(invalid.valid).toBe(false);
            expect(invalid.issues).toContainEqual(
                expect.objectContaining({ code: "unknown_depends_on", path: ["apps", 0, "depends_on", 0] }),
            );
            expect(invalid.issues).toContainEqual(
                expect.objectContaining({ code: "multiple_primary", path: ["apps", 1, "primary"] }),
            );

            const warningsOnly = await manager.validatePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [{ name: "web", path: ".", port: 3000 }],
            });

            expect(warningsOnly.valid).toBe(true);
            expect(warningsOnly.issues).toContainEqual(
                expect.objectContaining({ code: "no_primary", severity: "warning" }),
            );
        });

        test("validatePreviewkitConfig preflight warns on missing paths and Dockerfiles", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_003);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                repoIntrospection: {
                    getRepoTree: async () => ({
                        paths: ["package.json", "apps/web/package.json", "apps/web/Dockerfile"],
                        truncated: false,
                    }),
                },
            });

            const result = await manager.validatePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [
                    { name: "web", path: "apps/web", port: 3000, primary: true, dockerfile: "Dockerfile" },
                    { name: "api", path: "apps/api", port: 4000, dockerfile: "Dockerfile.api" },
                ],
            });

            // Warnings never block.
            expect(result.valid).toBe(true);
            expect(result.issues).toContainEqual(
                expect.objectContaining({ code: "path_not_found", severity: "warning", path: ["apps", 1, "path"] }),
            );
            expect(result.issues).toContainEqual(
                expect.objectContaining({
                    code: "dockerfile_not_found",
                    severity: "warning",
                    path: ["apps", 1, "dockerfile"],
                }),
            );
            expect(result.issues.filter((issue) => issue.path[1] === 0)).toEqual([]);
        });

        test("savePreviewkitConfig stores dependency configs on the primary config (no satellite apps)", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_010);
            const depRepo: FakeRepo = { id: 93_011, name: "api", fullName: "acme/api", defaultBranch: "main" };
            const { github, applications } = buildTopologyServices(harness, orgId, [depRepo]);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            const saved = await manager.savePreviewkitConfig(appId, orgId, primaryDocumentWithDependency(), [
                {
                    repo: "acme/api",
                    // depends_on crosses repo documents: "db" is a primary-repo
                    // service. Semantics validate against the merged topology.
                    document: { version: 1, apps: [{ name: "api-app", path: ".", port: 4000, depends_on: ["db"] }] },
                },
            ]);

            expect(saved.saved).toBe(true);
            expect(saved.dependencyConfigs).toHaveLength(1);
            const dependency = saved.dependencyConfigs[0];
            expect(dependency).toMatchObject({ name: "api", repo: "acme/api", saved: true });
            // Dependency repos are NOT separate Applications: the config + secrets
            // live under the primary app, and no Application is created/linked.
            expect(dependency?.applicationId).toBe(appId);
            expect(applications.createMinimalApplication).not.toHaveBeenCalled();
            expect(github.linkRepository).not.toHaveBeenCalled();

            const dependencyApplication = await harness.db.application.findUnique({
                where: { organizationId_githubRepositoryId: { organizationId: orgId, githubRepositoryId: depRepo.id } },
                select: { id: true },
            });
            expect(dependencyApplication).toBeNull();

            // The dependency document is persisted on the primary app's config.
            const storedConfig = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                select: { dependencyDocuments: true },
            });
            expect(storedConfig.dependencyDocuments).not.toBeNull();

            // getPreviewkitConfig hydrates the dependency documents back.
            const loaded = await manager.getPreviewkitConfig(appId, orgId);
            expect(loaded.dependencyConfigs).toHaveLength(1);
            expect(loaded.dependencyConfigs[0]).toMatchObject({
                name: "api",
                repo: "acme/api",
                saved: true,
                applicationId: appId,
            });
            expect(loaded.dependencyConfigs[0]?.document?.apps[0]?.name).toBe("api-app");

            // A second save still creates no Application; config is latest-only,
            // so the single row is overwritten in place.
            const resaved = await manager.savePreviewkitConfig(appId, orgId, primaryDocumentWithDependency(), [
                {
                    repo: "acme/api",
                    document: { version: 1, apps: [{ name: "api-app", path: ".", port: 4001 }] },
                },
            ]);
            expect(applications.createMinimalApplication).not.toHaveBeenCalled();
            expect(resaved.dependencyConfigs[0]?.document?.apps[0]?.port).toBe(4001);
            const configRows = await harness.db.previewkitConfig.findMany({ where: { applicationId: appId } });
            expect(configRows).toHaveLength(1);
            const reloaded = await manager.getPreviewkitConfig(appId, orgId);
            expect(reloaded.dependencyConfigs[0]?.document?.apps[0]?.port).toBe(4001);
        });

        test("savePreviewkitConfig returns warning-severity issues instead of dropping them", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_015);
            await setStep(harness, appId, "previewkit_configuring");

            // A postgres service no app connection references: the save must
            // succeed (warning severity never blocks) but carry the warning, so
            // the MCP agent path hears about the missing wiring at apply_config
            // time instead of after a green deploy with a broken runtime.
            const saved = await manager.savePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [{ name: "web", path: ".", port: 3000, primary: true }],
                services: [{ name: "db", recipe: "postgres" }],
            });

            expect(saved.saved).toBe(true);
            expect(saved.warnings).toContainEqual(
                expect.objectContaining({ code: "unreferenced_database_service", severity: "warning" }),
            );
        });

        test("savePreviewkitConfig rejects undeclared dependency repos and merged duplicate names", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_020);
            const depRepo: FakeRepo = { id: 93_021, name: "api", fullName: "acme/api", defaultBranch: "main" };
            const { github, applications } = buildTopologyServices(harness, orgId, [depRepo]);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            await expect(
                manager.savePreviewkitConfig(
                    appId,
                    orgId,
                    { version: 1, apps: [{ name: "web", path: ".", port: 3000, primary: true }] },
                    [
                        {
                            repo: "acme/api",
                            document: { version: 1, apps: [{ name: "api-app", path: ".", port: 4000 }] },
                        },
                    ],
                ),
            ).rejects.toThrow("is not declared in the primary config's multirepo.repos");

            await expect(
                manager.savePreviewkitConfig(appId, orgId, primaryDocumentWithDependency(), [
                    {
                        repo: "acme/api",
                        document: { version: 1, apps: [{ name: "web", path: ".", port: 4000 }] },
                    },
                ]),
            ).rejects.toThrow("names must be unique across the merged preview topology");
        });

        test("triggerPreviewkitMainDeploy rejects a semantically invalid saved config", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_030);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient: {
                    isConfigured: () => true,
                    deployApplicationMain: vi.fn(async () => undefined),
                    redeploy: vi.fn(async () => undefined),
                },
            });
            await setStep(harness, appId, "previewkit_configuring");

            // Written directly (bypassing the save validation) to simulate a
            // config saved before semantic checks existed.
            await harness.db.previewkitConfig.create({
                data: {
                    applicationId: appId,
                    document: {
                        version: 1,
                        apps: [{ name: "web", path: ".", port: 3000, primary: true, depends_on: ["ghost"] }],
                    },
                },
            });

            await expect(manager.triggerPreviewkitMainDeploy(appId, orgId)).rejects.toThrow(
                "Saved PreviewKit config has blocking issues",
            );
        });

        test("getPreviewReadiness reports log availability and classifies build failures", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 93_040;
            const repoFullName = `acme/web-${appId}`;
            await linkRepository(harness, appId, githubRepositoryId);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption);
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");
            await manager.savePreviewkitConfig(appId, orgId, {
                version: 1,
                apps: [{ name: "web", path: "apps/web", port: 3000, primary: true }],
                services: [],
            });
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "previewkit_deploying", previewVerificationStatus: "building" },
            });
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-topology-${appId}`,
                    repoFullName,
                    prNumber: 0,
                    headSha: "sha-1",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "failed",
                    phase: "building-images",
                    urls: {},
                    // Merged snapshot includes a dependency-repo app the primary
                    // config knows nothing about - field paths must still resolve.
                    resolvedConfig: {
                        version: 1,
                        apps: [
                            { name: "web", path: "apps/web", port: 3000, primary: true },
                            { name: "api-app", path: "missing/dir", port: 4000 },
                        ],
                        services: [],
                    },
                },
            });
            await harness.db.previewkitBuild.create({
                data: {
                    environmentId: environment.id,
                    headSha: "sha-1",
                    status: "failed",
                    appBuilds: {
                        create: [
                            {
                                appName: "web",
                                status: "failed",
                                durationMs: 1200,
                                error: 'No repo directory found for app "web"',
                            },
                            {
                                appName: "api-app",
                                status: "failed",
                                durationMs: 800,
                                error: 'No repo directory found for app "api-app"',
                            },
                        ],
                    },
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("failed");
            expect(readiness.diagnostics.logs).toEqual({ available: true, repoFullName, prNumber: 0 });
            expect(readiness.diagnostics.failures).toContainEqual(
                expect.objectContaining({ code: "missing_path", appName: "web", fieldPath: "apps.0.path" }),
            );
            // Dependency-repo apps resolve a fieldPath via the merged resolvedConfig snapshot.
            expect(readiness.diagnostics.failures).toContainEqual(
                expect.objectContaining({ code: "missing_path", appName: "api-app", fieldPath: "apps.1.path" }),
            );
        });
    },
});

async function linkRepository(harness: OnboardingTestHarness, applicationId: string, githubRepositoryId: number) {
    await harness.db.application.update({
        where: { id: applicationId },
        data: {
            githubRepositoryId,
            signingSecretEnc: fakeEncryption.encrypt("shared-secret"),
        },
    });
}

async function setStep(
    harness: OnboardingTestHarness,
    applicationId: string,
    step: "preview_environment" | "previewkit_configuring",
) {
    await harness.db.onboardingState.upsert({
        where: { applicationId },
        create: { applicationId, step },
        update: { step },
    });
}

function primaryDocumentWithDependency() {
    return {
        version: 1,
        config: { multirepo: { repos: [{ name: "api", repo: "acme/api", fallback_branch: "main" }] } },
        apps: [{ name: "web", path: ".", port: 3000, primary: true }],
        services: [{ name: "db", recipe: "postgres", version: "16" }],
    };
}
