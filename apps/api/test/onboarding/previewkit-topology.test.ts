import { previewkitConfigCreateChildren } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import { previewkitConfigRowValues, trustedPreviewConfigSchema } from "@autonoma/types";
import { expect, vi } from "vitest";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import { OnboardingTestHarness } from "./onboarding-harness";

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
        listRepositories: vi.fn(async () => ({ repos })),
        linkRepository: vi.fn(async (organizationId: string, applicationId: string, githubRepoId: number) => {
            await harness.db.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId: githubRepoId },
            });
            void organizationId;
        }),
        getBranchHead: vi.fn(async () => "0".repeat(40)),
        listApplicationBranches: vi.fn(async () => ({
            names: ["main", "develop"],
            defaultBranch: "main",
            truncated: false,
        })),
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
                version: 2,
                apps: [{ name: "web", repository: "acme/web", path: "." }],
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
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        path: ".",
                        port: 3000,
                        primary: true,
                        depends_on: ["ghost"],
                    },
                    { name: "api", repository: "acme/web", path: "apps/api", port: 4000, primary: true },
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
                version: 2,
                apps: [{ name: "web", repository: "acme/web", path: ".", port: 3000 }],
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
            const { github, applications } = buildTopologyServices(harness, orgId, [
                { id: 93_003, name: "web", fullName: "acme/web", defaultBranch: "main" },
            ]);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
                repoIntrospection: {
                    getRepoTree: async () => ({
                        paths: ["package.json", "apps/web/package.json", "apps/web/Dockerfile"],
                        truncated: false,
                    }),
                },
            });

            const result = await manager.validatePreviewkitConfig(appId, orgId, {
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        path: "apps/web",
                        port: 3000,
                        primary: true,
                        dockerfile: "Dockerfile",
                    },
                    { name: "api", repository: "acme/web", path: "apps/api", port: 4000, dockerfile: "Dockerfile.api" },
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

        test("savePreviewkitConfig persists a multi-repo document as one row (no satellite apps)", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_010);
            const depRepo: FakeRepo = { id: 93_011, name: "api", fullName: "acme/api", defaultBranch: "main" };
            const { github, applications } = buildTopologyServices(harness, orgId, [
                { id: 93_010, name: "web", fullName: "acme/web", defaultBranch: "main" },
                depRepo,
            ]);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            const saved = await manager.savePreviewkitConfig(appId, orgId, multiRepoDocument());

            expect(saved.saved).toBe(true);
            // Every repository of the topology is reported, primary flagged and
            // resolved against the installation listing.
            expect(saved.repos).toEqual([
                { repo: "acme/web", primary: true, githubRepositoryId: 93_010 },
                { repo: "acme/api", primary: false, githubRepositoryId: 93_011 },
            ]);
            // Dependency repos are NOT separate Applications: the whole topology is
            // one document under the primary app, and no Application is created/linked.
            expect(applications.createMinimalApplication).not.toHaveBeenCalled();
            expect(github.linkRepository).not.toHaveBeenCalled();
            const dependencyApplication = await harness.db.application.findUnique({
                where: { organizationId_githubRepositoryId: { organizationId: orgId, githubRepositoryId: depRepo.id } },
                select: { id: true },
            });
            expect(dependencyApplication).toBeNull();

            // One row holding the whole topology - there is no dependency sidecar.
            const storedConfig = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                select: { document: true },
            });
            expect(storedConfig.document).toMatchObject({ version: 2 });

            // getPreviewkitConfig round-trips the whole topology.
            const loaded = await manager.getPreviewkitConfig(appId, orgId);
            expect(loaded.saved).toBe(true);
            expect(loaded.document.apps.map((app) => app.name)).toEqual(["web", "api-app"]);
            expect(loaded.document.apps[1]?.repository).toBe("acme/api");
            expect(loaded.document.repositories).toEqual([{ repo: "acme/api", fallback_branch: "main" }]);
            expect(loaded.repos).toEqual(saved.repos);

            // Config is latest-only: a second save overwrites the single row in place.
            const nextDocument = multiRepoDocument();
            const dependencyApp = nextDocument.apps[1];
            if (dependencyApp == null) throw new Error("multiRepoDocument must have a dependency app");
            dependencyApp.port = 4001;
            await manager.savePreviewkitConfig(appId, orgId, nextDocument);
            expect(applications.createMinimalApplication).not.toHaveBeenCalled();
            const configRows = await harness.db.previewkitConfig.findMany({ where: { applicationId: appId } });
            expect(configRows).toHaveLength(1);
            const reloaded = await manager.getPreviewkitConfig(appId, orgId);
            expect(reloaded.document.apps[1]?.port).toBe(4001);
        });

        test("savePreviewkitConfig accepts secrets for a dependency-repo app", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_050);
            const { github, applications } = buildTopologyServices(harness, orgId, [
                { id: 93_050, name: "web", fullName: "acme/web", defaultBranch: "main" },
                { id: 93_051, name: "api", fullName: "acme/api", defaultBranch: "main" },
            ]);
            const secretsService = {
                list: vi.fn(async () => []),
                upsert: vi.fn(async () => undefined),
                delete: vi.fn(async () => true),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
                previewkitSecretsService: secretsService,
            });
            await setStep(harness, appId, "previewkit_configuring");

            // The app lives on a dependency repo, and its secret bundle lives under
            // this same Application - the save judges the name against the whole
            // document, not just the primary repo's apps.
            await manager.savePreviewkitConfig(appId, orgId, multiRepoDocument(), [
                { appName: "api-app", upserts: [{ key: "RAILS_MASTER_KEY", value: "s3cret" }], deletes: [] },
            ]);

            expect(secretsService.upsert).toHaveBeenCalledWith(
                appId,
                "api-app",
                [{ key: "RAILS_MASTER_KEY", value: "s3cret" }],
                orgId,
            );

            // A name the document does not declare is still rejected, and nothing is written.
            secretsService.upsert.mockClear();
            await expect(
                manager.savePreviewkitConfig(appId, orgId, multiRepoDocument(), [
                    { appName: "ghost", upserts: [{ key: "TOKEN", value: "x" }], deletes: [] },
                ]),
            ).rejects.toThrow("PreviewKit app 'ghost' is not defined in the config");
            expect(secretsService.upsert).not.toHaveBeenCalled();
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
                version: 2,
                apps: [{ name: "web", repository: "acme/web", path: ".", port: 3000, primary: true }],
                services: [{ name: "db", recipe: "postgres" }],
            });

            expect(saved.saved).toBe(true);
            expect(saved.warnings).toContainEqual(
                expect.objectContaining({ code: "unreferenced_database_service", severity: "warning" }),
            );
        });

        test("savePreviewkitConfig refuses an unresolvable primary repository (never persists a guess)", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            // Linked to GitHub by id, but the id is in no installation listing
            // and no preview ever deployed - the full name cannot be resolved.
            const appId = await createApp();
            await harness.db.application.update({
                where: { id: appId },
                data: { githubRepositoryId: 93_016, signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            await setStep(harness, appId, "previewkit_configuring");

            const document = {
                version: 2,
                apps: [{ name: "web", repository: "acme/web", path: ".", port: 3000, primary: true }],
            };
            await expect(manager.savePreviewkitConfig(appId, orgId, document)).rejects.toThrow(
                "Could not resolve this application's repository",
            );
            expect(await harness.db.previewkitConfig.findUnique({ where: { applicationId: appId } })).toBeNull();

            // The editor's live validation reports the same block as data.
            const validation = await manager.validatePreviewkitConfig(appId, orgId, document);
            expect(validation.valid).toBe(false);
            expect(validation.issues).toContainEqual(
                expect.objectContaining({ code: "primary_repository_unresolved", severity: "error" }),
            );
        });

        test("savePreviewkitConfig warns on inaccessible repos and rejects a topology skipping the primary repo", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_020);
            // The installation can see only the primary repo - acme/api is not granted.
            const { github, applications } = buildTopologyServices(harness, orgId, [
                { id: 93_020, name: "web", fullName: "acme/web", defaultBranch: "main" },
            ]);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            // An app on a repo the installation cannot access saves fine, but the
            // warning surfaces so the user learns the app would be skipped at deploy.
            const saved = await manager.savePreviewkitConfig(appId, orgId, multiRepoDocument());
            expect(saved.saved).toBe(true);
            expect(saved.warnings).toContainEqual(
                expect.objectContaining({
                    code: "repository_not_accessible",
                    severity: "warning",
                    path: ["apps", 1, "repository"],
                }),
            );

            // A document with NO app on the Application's own repo would never
            // deploy the PR's code - that is a blocking error.
            await expect(
                manager.savePreviewkitConfig(appId, orgId, {
                    version: 2,
                    apps: [{ name: "api-app", repository: "acme/api", path: ".", port: 4000, primary: true }],
                }),
            ).rejects.toThrow(/No app builds from this application's repository "acme\/web"/);

            // Duplicate names across repos are ordinary within-document schema errors.
            await expect(
                manager.savePreviewkitConfig(appId, orgId, {
                    version: 2,
                    apps: [
                        { name: "web", repository: "acme/web", path: ".", port: 3000, primary: true },
                        { name: "web", repository: "acme/api", path: ".", port: 4000 },
                    ],
                }),
            ).rejects.toThrow("names must be unique across apps and services");
        });

        test("triggerPreviewkitMainDeploy rejects a semantically invalid saved config", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_030);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient: {
                    deployApplicationMain: vi.fn(async () => undefined),
                    redeploy: vi.fn(async () => undefined),
                    startRunForPullRequest: vi.fn(async () => undefined),
                },
            });
            await setStep(harness, appId, "previewkit_configuring");

            // Written directly (bypassing the save validation) to simulate a
            // config saved before semantic checks existed. Decomposed the same way
            // the save path does it, so the rows the reader loads are the real thing:
            // this shape is schema-valid and only fails the semantic pass.
            const stored = trustedPreviewConfigSchema.parse({
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        path: ".",
                        port: 3000,
                        primary: true,
                        depends_on: ["ghost"],
                    },
                ],
            });
            await harness.db.previewkitConfig.create({
                data: {
                    applicationId: appId,
                    document: JSON.parse(JSON.stringify(stored)),
                    ...previewkitConfigCreateChildren(previewkitConfigRowValues(stored)),
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
            await linkRepository(harness, appId, githubRepositoryId, repoFullName);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption);
            await setStep(harness, appId, "preview_environment");
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");
            await manager.savePreviewkitConfig(appId, orgId, {
                version: 2,
                apps: [{ name: "web", repository: repoFullName, path: "apps/web", port: 3000, primary: true }],
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
                    // The resolved snapshot spans repos: the dependency-repo app is an
                    // ordinary entry of the one document - field paths must still resolve.
                    resolvedConfig: {
                        version: 2,
                        apps: [
                            { name: "web", repository: repoFullName, path: "apps/web", port: 3000, primary: true },
                            { name: "api-app", repository: "acme/api", path: "missing/dir", port: 4000 },
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

        test("setDeployBranch validates against GitHub, persists the branch, and getConfig reflects it", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_042);
            const { github, applications } = buildTopologyServices(harness, orgId, []);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "previewkit_configuring");

            const result = await manager.setDeployBranch(appId, orgId, "refs/heads/release");

            expect(result.branch).toBe("release");
            expect(github.getBranchHead).toHaveBeenCalledWith(orgId, 93_042, "release");

            const config = await manager.getPreviewkitConfig(appId, orgId);
            expect(config.deployBranch).toBe("release");
        });

        test("setDeployBranch redirects the base preview without redefining the app's trunk", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_043);
            const { github, applications } = buildTopologyServices(harness, orgId, []);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "previewkit_configuring");
            const before = await harness.db.application.findUniqueOrThrow({
                where: { id: appId },
                select: { mainBranch: { select: { name: true } }, mainBranchInfo: { select: { githubRef: true } } },
            });

            await manager.setDeployBranch(appId, orgId, "autonoma-integration");

            const after = await harness.db.application.findUniqueOrThrow({
                where: { id: appId },
                select: {
                    previewDeployRef: true,
                    mainBranch: { select: { name: true } },
                    mainBranchInfo: { select: { githubRef: true } },
                },
            });
            expect(after.previewDeployRef).toBe("autonoma-integration");
            expect(after.mainBranch?.name).toBe(before.mainBranch?.name);
            expect(after.mainBranchInfo?.githubRef).toBe(before.mainBranchInfo?.githubRef);
        });

        test("the deploy-branch picker falls back to the trunk when no deploy ref is set", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_044);
            const { github, applications } = buildTopologyServices(harness, orgId, []);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            const trunk = await harness.db.application.findUniqueOrThrow({
                where: { id: appId },
                select: { mainBranch: { select: { name: true } } },
            });

            const options = await manager.listDeployBranchOptions(appId, orgId);

            expect(options.currentBranch).toBe(trunk.mainBranch?.name);
        });

        test("setDeployBranch rejects a branch that doesn't exist on GitHub", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 93_041);
            const { github, applications } = buildTopologyServices(harness, orgId, []);
            github.getBranchHead.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                github,
                applications,
            });
            await setStep(harness, appId, "previewkit_configuring");

            await expect(manager.setDeployBranch(appId, orgId, "ghost")).rejects.toThrow(/not found on GitHub/);
        });
    },
});

/**
 * Every case shares the suite's one organization, and `github_repository_id` is unique per
 * organization - so each case must pass a `githubRepositoryId` no other case in this file uses.
 */
async function linkRepository(
    harness: OnboardingTestHarness,
    applicationId: string,
    githubRepositoryId: number,
    repoFullName = "acme/web",
) {
    const application = await harness.db.application.update({
        where: { id: applicationId },
        data: {
            githubRepositoryId,
            signingSecretEnc: fakeEncryption.encrypt("shared-secret"),
        },
        select: { organizationId: true },
    });
    // Saves refuse an unresolvable primary repo. Cases whose fake GitHub listing
    // does not carry this id resolve through the PreviewkitEnvironment fallback,
    // so seed one row naming the repo (unique on (repoFullName, prNumber) - the
    // per-case-unique github id doubles as the PR number).
    await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-seed-${githubRepositoryId}`,
            repoFullName,
            prNumber: githubRepositoryId,
            headSha: "seed000",
            headRef: "main",
            githubRepositoryId,
            organizationId: application.organizationId,
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

/**
 * A whole multi-repo topology in ONE document: the primary-repo app plus a
 * dependency-repo app, the dependency repo's defaults overridden in
 * `repositories[]`. `depends_on` crosses repos freely - "db" is declared
 * alongside the primary app and semantics validate the whole topology.
 */
function multiRepoDocument() {
    return {
        version: 2,
        repositories: [{ repo: "acme/api", fallback_branch: "main" }],
        apps: [
            { name: "web", repository: "acme/web", path: ".", port: 3000, primary: true },
            { name: "api-app", repository: "acme/api", path: ".", port: 4000, depends_on: ["db"] },
        ],
        services: [{ name: "db", recipe: "postgres", version: "16" }],
    };
}
