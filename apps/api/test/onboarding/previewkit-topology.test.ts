import { FakeGitHubApp, FakeGitHubInstallationClient } from "@autonoma/github";
import { integrationTestSuite } from "@autonoma/integration-test";
import { EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import { expect, vi } from "vitest";
import { RepoIntrospectionService } from "../../src/github/repo-introspection.service";
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

        test("savePreviewkitConfig persists dependency repo revisions and links their Applications", async ({
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
                    document: {
                        version: 1,
                        // depends_on crosses repo documents: "db" is a primary-repo
                        // service. Semantics validate against the merged topology.
                        apps: [{ name: "api-app", path: ".", port: 4000, depends_on: ["db"] }],
                    },
                },
            ]);

            expect(saved.saved).toBe(true);
            expect(saved.dependencyConfigs).toHaveLength(1);
            const dependency = saved.dependencyConfigs[0];
            expect(dependency).toMatchObject({ name: "api", repo: "acme/api", saved: true, revision: 1 });
            expect(applications.createMinimalApplication).toHaveBeenCalledOnce();
            expect(github.linkRepository).toHaveBeenCalledWith(orgId, dependency?.applicationId, depRepo.id);

            const dependencyApplication = await harness.db.application.findUniqueOrThrow({
                where: { id: dependency?.applicationId ?? "" },
                select: { githubRepositoryId: true, activeConfigRevisionId: true },
            });
            expect(dependencyApplication.githubRepositoryId).toBe(depRepo.id);
            expect(dependencyApplication.activeConfigRevisionId).toBe(dependency?.revisionId);

            // getPreviewkitConfig hydrates the dependency documents back.
            const loaded = await manager.getPreviewkitConfig(appId, orgId);
            expect(loaded.dependencyConfigs).toHaveLength(1);
            expect(loaded.dependencyConfigs[0]).toMatchObject({ name: "api", repo: "acme/api", saved: true });
            expect(loaded.dependencyConfigs[0]?.document?.apps[0]?.name).toBe("api-app");

            // A second save reuses the linked Application and bumps its revision.
            const resaved = await manager.savePreviewkitConfig(appId, orgId, primaryDocumentWithDependency(), [
                {
                    repo: "acme/api",
                    document: { version: 1, apps: [{ name: "api-app", path: ".", port: 4001 }] },
                },
            ]);
            expect(applications.createMinimalApplication).toHaveBeenCalledOnce();
            expect(resaved.dependencyConfigs[0]?.revision).toBe(2);
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

        test("triggerPreviewkitMainDeploy rejects a semantically invalid active revision", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_030);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient: {
                    isConfigured: () => true,
                    deployApplicationMain: vi.fn(async () => undefined),
                },
            });
            await setStep(harness, appId, "previewkit_configuring");

            // Written directly (bypassing the save validation) to simulate a
            // revision created before semantic checks existed.
            const revision = await harness.db.previewkitConfigRevision.create({
                data: {
                    applicationId: appId,
                    revision: 1,
                    schemaVersion: 1,
                    document: {
                        version: 1,
                        apps: [{ name: "web", path: ".", port: 3000, primary: true, depends_on: ["ghost"] }],
                    },
                },
            });
            await harness.db.application.update({
                where: { id: appId },
                data: { activeConfigRevisionId: revision.id },
            });

            await expect(manager.triggerPreviewkitMainDeploy(appId, orgId)).rejects.toThrow(
                "Active PreviewKit config has blocking issues",
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
                    // revision knows nothing about - field paths must still resolve.
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

        test("RepoIntrospectionService suggests apps from a pnpm workspace monorepo", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 93_050;
            await linkRepository(harness, appId, githubRepositoryId);
            const installationId = 93_051;
            await harness.db.gitHubInstallation.create({
                data: {
                    installationId,
                    organizationId: orgId,
                    accountLogin: "acme",
                    accountId: 1,
                    accountType: "Organization",
                    status: "active",
                },
            });
            const client = new FakeGitHubInstallationClient();
            client.addRepository({
                id: githubRepositoryId,
                name: "platform",
                fullName: "acme/platform",
                commits: ["head-sha"],
            });
            client.setFile("acme/platform", "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
            client.setFile("acme/platform", "package.json", JSON.stringify({ name: "platform", private: true }));
            client.setFile(
                "acme/platform",
                "apps/web/package.json",
                JSON.stringify({
                    name: "@acme/web",
                    scripts: { dev: "next dev -p 3001" },
                    dependencies: { next: "*" },
                }),
            );
            client.setFile(
                "acme/platform",
                "apps/api/package.json",
                JSON.stringify({ name: "@acme/api", scripts: { start: "node server.js" } }),
            );
            client.setFile("acme/platform", "apps/api/Dockerfile", "FROM node:20");
            const githubApp = new FakeGitHubApp();
            githubApp.setClient(installationId, client);
            const service = new RepoIntrospectionService(harness.db, githubApp);

            const result = await service.introspect(orgId, appId);

            expect(result.status).toBe("ok");
            expect(result.monorepoTool).toBe("pnpm-workspace");
            expect(result.dockerfiles).toEqual(["apps/api/Dockerfile"]);
            const web = result.apps.find((app) => app.name === "web");
            expect(web).toMatchObject({ path: "apps/web", port: 3001, confidence: "high" });
            const api = result.apps.find((app) => app.name === "api");
            expect(api).toMatchObject({ path: "apps/api", dockerfile: "Dockerfile", confidence: "high" });
        });

        test("RepoIntrospectionService degrades to unavailable when GitHub cannot be read", async ({ harness }) => {
            // Fresh org: GitHubInstallation is unique per organization and the
            // previous case already installed one for the seed org.
            const orgId = await harness.createOrg();
            const appId = await harness.createApp(orgId);
            await linkRepository(harness, appId, 93_060);
            await harness.db.gitHubInstallation.create({
                data: {
                    installationId: 93_061,
                    organizationId: orgId,
                    accountLogin: "acme-2",
                    accountId: 2,
                    accountType: "Organization",
                    status: "active",
                },
            });
            // The fake's default client knows nothing about repo 93_060, so the
            // repository lookup throws - introspection must degrade, not fail.
            const service = new RepoIntrospectionService(harness.db, new FakeGitHubApp());

            const result = await service.introspect(orgId, appId);

            expect(result.status).toBe("unavailable");
            expect(result.apps).toEqual([]);
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
