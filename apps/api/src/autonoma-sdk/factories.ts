import { randomBytes, randomUUID } from "node:crypto";
import { defineFactory } from "@autonoma-ai/sdk";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { toSlug } from "@autonoma/utils";
import { z } from "zod";

const logger = rootLogger.child({ name: "AutonomaSdkFactories" });

/**
 * Slug/name/email identifiers are honored VERBATIM when a scenario supplies them
 * - the router resolves `/app/:slug`, `/snapshots/:id`, `/issues/:id` by exact
 * match, so a factory-appended random suffix would make every deep-link URL a
 * test navigates to unresolvable. A random value is synthesized ONLY when the
 * field is omitted. Cross-run uniqueness is the scenario's job (a per-run
 * `{testRunId}`-templated value for globally-unique columns), backed by the
 * org-cascade teardown that resets state between runs - NOT a factory suffix.
 */
function slugOrSuffixed(supplied: string | undefined, fallbackName: string, suffix: string): string {
    return supplied != null ? toSlug(supplied) : `${toSlug(fallbackName)}-${suffix}`;
}

/**
 * Factories for the Autonoma SDK test-data endpoint. Every factory writes
 * directly through Prisma (raw insert fallback). The real creation paths
 * (ApplicationsService.createApplication, BetterAuth signup, Temporal
 * workflows, etc.) can't be invoked in a single-process local setup without
 * running the whole workflow fleet + K8s + GitHub app, so factories preserve
 * invariants by copying the fields the real handlers write.
 *
 * Teardown strategy: every created row is either scoped to the seeded
 * Organization (cascade on organization delete) or explicitly tracked and
 * deleted in reverse-dependency order in the beforeDown hook of the handler
 * config. Factories return only their id; the handler owns the org-cascade
 * teardown to avoid double-deletes when a parent has already been removed.
 */

function loose<T extends z.ZodRawShape>(shape: T) {
    // Zod v4 loose object: extra keys allowed, unknown keys not required to match.
    return z.object(shape).loose();
}

const emptyRef = z.object({ id: z.string() });

// ─────────────────────────────────────────────────────────────────────────
// Root-authority: Organization, User, Verification, Jwks, OauthApplication,
// BillingPromoCode, BenchmarkBatch. Nothing above them in the create graph.
// ─────────────────────────────────────────────────────────────────────────

const OrganizationInput = loose({
    name: z.string().optional(),
    slug: z.string().optional(),
    status: z.enum(["pending", "approved", "rejected"]).optional(),
    domain: z.string().optional(),
});

const OrganizationFactory = defineFactory({
    inputSchema: OrganizationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex");
        const name = data.name ?? `Autonoma Test Org ${suffix}`;
        const slug = slugOrSuffixed(data.slug, name, suffix);
        const row = await db.organization.create({
            data: {
                name,
                slug,
                status: data.status ?? "approved",
                domain: data.domain ?? undefined,
            },
        });
        logger.info("Created organization", { extra: { organizationId: row.id, slug: row.slug } });
        return { id: row.id };
    },
});

const UserInput = loose({
    email: z.string().optional(),
    name: z.string().optional(),
    role: z.enum(["user", "admin"]).optional(),
    emailVerified: z.boolean().optional(),
    image: z.string().optional(),
});

const UserFactory = defineFactory({
    inputSchema: UserInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex");
        // User.email is GLOBALLY unique, so it must be made per-run unique or
        // concurrent/repeated runs collide (Prisma P2002 on email -> up 500s).
        // Auth here is cookie-based (the browser never types the email), so the
        // exact value is irrelevant - splice the run suffix into the local part,
        // preserving a readable domain. Never default to an @autonoma.app address:
        // the login hook would pull the user into the shared real org + make them
        // admin (see auth.ts ensureOrgMembership).
        const email =
            data.email != null ? data.email.replace("@", `+${suffix}@`) : `autonoma-test-${suffix}@autonoma.local`;
        const row = await db.user.create({
            data: {
                email,
                name: data.name ?? `Autonoma Test User ${suffix}`,
                emailVerified: data.emailVerified ?? true,
                role: data.role ?? "user",
                image: data.image ?? undefined,
            },
        });
        return { id: row.id };
    },
    teardown: async (record) => {
        await db.user.deleteMany({ where: { id: record.id } });
    },
});

const VerificationInput = loose({
    identifier: z.string().optional(),
    value: z.string().optional(),
    expiresInSeconds: z.number().optional(),
});

const VerificationFactory = defineFactory({
    inputSchema: VerificationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex");
        const row = await db.verification.create({
            data: {
                identifier: data.identifier ?? `verify-${suffix}@autonoma.local`,
                value: data.value ?? randomBytes(16).toString("hex"),
                expiresAt: new Date(Date.now() + (data.expiresInSeconds ?? 3600) * 1000),
            },
        });
        return { id: row.id };
    },
    teardown: async (record) => {
        await db.verification.deleteMany({ where: { id: record.id } });
    },
});

const JwksInput = loose({
    publicKey: z.string().optional(),
    privateKey: z.string().optional(),
});

const JwksFactory = defineFactory({
    inputSchema: JwksInput,
    refSchema: emptyRef,
    // Jwks holds Better Auth's OWN JWT signing keys - it is framework infrastructure,
    // NOT app test data. Seeding a fake (PEM) key here poisons the jwt() plugin: it
    // parses the stored key as a JWK, chokes on `-----BEGIN…`, and 500s get-session,
    // which breaks ALL authentication (the browser can never establish a session).
    // So this factory is a deliberate no-op: acknowledge the alias without writing a
    // row, leaving Better Auth's real, auto-generated key intact.
    create: async () => ({ id: `jwks-noop-${randomBytes(8).toString("hex")}` }),
    teardown: async () => {},
});

const OauthApplicationInput = loose({
    name: z.string().optional(),
    clientId: z.string().optional(),
    redirectUrls: z.union([z.string(), z.array(z.string())]).optional(),
    type: z.string().optional(),
    userId: z.string().optional(),
});

const OauthApplicationFactory = defineFactory({
    inputSchema: OauthApplicationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex");
        const redirectUrls = Array.isArray(data.redirectUrls)
            ? data.redirectUrls.join(",")
            : (data.redirectUrls ?? `https://mcp.autonoma.local/callback-${suffix}`);
        const row = await db.oauthApplication.create({
            data: {
                name: data.name ?? `Autonoma Test OAuth ${suffix}`,
                clientId: data.clientId ?? `client-${suffix}`,
                redirectUrls,
                type: data.type ?? "user",
                userId: data.userId,
            },
        });
        return { id: row.id };
    },
    teardown: async (record) => {
        await db.oauthApplication.deleteMany({ where: { id: record.id } });
    },
});

const BillingPromoCodeInput = loose({
    code: z.string().optional(),
    description: z.string().optional(),
    grantCredits: z.number().optional(),
    maxRedemptions: z.number().optional(),
    isActive: z.boolean().optional(),
});

const BillingPromoCodeFactory = defineFactory({
    inputSchema: BillingPromoCodeInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex").toUpperCase();
        const row = await db.billingPromoCode.create({
            data: {
                code: data.code ? `${data.code}_${suffix}` : `AUTONOMA_TEST_${suffix}`,
                description: data.description ?? "Autonoma SDK test promo code",
                grantCredits: data.grantCredits ?? 50_000,
                maxRedemptions: data.maxRedemptions ?? undefined,
                isActive: data.isActive ?? true,
            },
        });
        return { id: row.id };
    },
    teardown: async (record) => {
        await db.billingPromoCode.deleteMany({ where: { id: record.id } });
    },
});

// BenchmarkBatch: entity audit says it lives in a separate db-evals database
// via scripts/run-benchmark.ts. The main Prisma schema has NO benchmark tables,
// so we can't create it against the main DB here. We record a synthetic id so
// discover advertises it, and the up path is a no-op that returns a synthetic
// ref — teardown is likewise a no-op.
const BenchmarkBatchInput = loose({
    status: z.string().optional(),
    repeatCount: z.number().optional(),
    appUrls: z.array(z.string()).optional(),
});

const BenchmarkBatchFactory = defineFactory({
    inputSchema: BenchmarkBatchInput,
    refSchema: emptyRef,
    // Raw-insert fallback: no db-evals schema in the main Prisma client. The
    // real creation path is scripts/run-benchmark.ts writing to a separate
    // evals database. Returning a synthetic id keeps the recipe/schema valid
    // for discover / up / down without touching the wrong DB.
    create: async () => {
        const id = `bbatch-synth-${randomUUID()}`;
        logger.info("BenchmarkBatch factory synthesized (evals DB not wired)", { extra: { benchmarkBatchId: id } });
        return { id };
    },
    teardown: async () => {
        // no-op — nothing was written
    },
});

// ─────────────────────────────────────────────────────────────────────────
// Organization-scoped roots (all cascade-deleted when the seeded org goes)
// ─────────────────────────────────────────────────────────────────────────

const ApplicationInput = loose({
    name: z.string().optional(),
    slug: z.string().optional(),
    architecture: z.enum(["WEB", "IOS", "ANDROID"]).optional(),
    organizationId: z.string(),
    githubRepositoryId: z.number().optional(),
});

const ApplicationFactory = defineFactory({
    inputSchema: ApplicationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(4).toString("hex");
        const name = data.name ?? `Test App ${suffix}`;
        // Slug is honored verbatim so `/app/:slug` (exact-match) resolves - see
        // slugOrSuffixed. ApplicationsService.createApplication also creates
        // OnboardingState, Branch (main) with MainBranchInfo, BranchDeployment
        // (+ Web/Mobile subtype), and Folder(root). Recipes seed those explicitly
        // by referencing this Application (Branch factory wires mainBranchId via
        // `isMainBranch`), so we DO NOT auto-create them here.
        const slug = slugOrSuffixed(data.slug, name, suffix);
        const row = await db.application.create({
            data: {
                name,
                slug,
                architecture: data.architecture ?? "WEB",
                organizationId: data.organizationId,
                githubRepositoryId: data.githubRepositoryId ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const ApplicationSetupInput = loose({
    applicationId: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
    currentStep: z.number().optional(),
    totalSteps: z.number().optional(),
});

const ApplicationSetupFactory = defineFactory({
    inputSchema: ApplicationSetupInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.applicationSetup.create({
            data: {
                name: data.name ?? "Autonoma test setup",
                status: data.status ?? "completed",
                currentStep: data.currentStep ?? 5,
                totalSteps: data.totalSteps ?? 5,
                completedAt: new Date(),
                applicationId: data.applicationId,
                organizationId: data.organizationId,
                userId: data.userId,
            },
        });
        return { id: row.id };
    },
});

// The real ApplicationsService.createApplication seeds an OnboardingState row;
// the app's list gate only checks app-count, but the Finish-setup / SDK-validation
// screens read this, so seed it complete for a coherent tenant.
const OnboardingStateInput = loose({
    applicationId: z.string(),
    productionUrl: z.string().optional(),
    previewUrl: z.string().optional(),
});

const OnboardingStateFactory = defineFactory({
    inputSchema: OnboardingStateInput,
    refSchema: emptyRef,
    create: async (data) => {
        const now = new Date();
        const row = await db.onboardingState.create({
            data: {
                applicationId: data.applicationId,
                step: "completed",
                completedAt: now,
                dryRunPassedAt: now,
                previewVerificationStatus: "ready",
                productionUrl: data.productionUrl ?? undefined,
                previewUrl: data.previewUrl ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const BranchInput = loose({
    name: z.string().optional(),
    applicationId: z.string(),
    organizationId: z.string(),
    isMainBranch: z.boolean().optional(),
    githubRef: z.string().optional(),
});

const BranchFactory = defineFactory({
    inputSchema: BranchInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const row = await db.branch.create({
            data: {
                name: data.name ?? `branch-${suffix}`,
                applicationId: data.applicationId,
                organizationId: data.organizationId,
            },
        });
        // Wire the app's main branch. listApplications DROPS any app whose
        // mainBranch is null (applications.service.ts:118), making the app
        // invisible and bouncing its user to onboarding - until mainBranchId
        // points at a real Branch. This is the circular FK
        // (Application.mainBranchId <-> Branch.applicationId) that the real
        // createApplication resolves post-insert; we do the same, and add the
        // MainBranchInfo(githubRef) row that marks it as the main branch.
        if (data.isMainBranch === true) {
            await db.application.update({
                where: { id: data.applicationId },
                data: { mainBranchId: row.id },
            });
            await db.mainBranchInfo.create({
                data: {
                    branchId: row.id,
                    applicationId: data.applicationId,
                    githubRef: data.githubRef ?? "refs/heads/main",
                },
            });
        }
        return { id: row.id };
    },
});

// A branch becomes a "pull request" when it has a FeatureBranchInfo row -
// `/pull-requests/:prNumber` resolves `where: { prInfo: { prNumber } }`
// (branches.service.ts getBranchByPr), unique per (applicationId, prNumber).
const FeatureBranchInfoInput = loose({
    branchId: z.string(),
    applicationId: z.string(),
    prNumber: z.number(),
    prTitle: z.string().optional(),
    prState: z.enum(["open", "closed", "merged"]).optional(),
    prAuthorLogin: z.string().optional(),
});

const FeatureBranchInfoFactory = defineFactory({
    inputSchema: FeatureBranchInfoInput,
    refSchema: emptyRef,
    // @id is branchId, so surface that as the ref id.
    create: async (data) => {
        const row = await db.featureBranchInfo.create({
            data: {
                branchId: data.branchId,
                applicationId: data.applicationId,
                prNumber: data.prNumber,
                prTitle: data.prTitle ?? undefined,
                prState: data.prState ?? "open",
                prAuthorLogin: data.prAuthorLogin ?? undefined,
                prCachedAt: new Date(),
            },
        });
        return { id: row.branchId };
    },
});

const BranchDeploymentInput = loose({
    branchId: z.string(),
    organizationId: z.string(),
    active: z.boolean().optional(),
    webhookUrl: z.string().optional(),
});

const BranchDeploymentFactory = defineFactory({
    inputSchema: BranchDeploymentInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.branchDeployment.create({
            data: {
                branchId: data.branchId,
                organizationId: data.organizationId,
                active: data.active ?? true,
                webhookUrl: data.webhookUrl ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const WebDeploymentInput = loose({
    deploymentId: z.string(),
    organizationId: z.string(),
    url: z.string().optional(),
    file: z.string().optional(),
});

// WebDeployment uses deploymentId as its @@id — the SDK ref must still expose
// an `id`, so we surface the deploymentId as id and repopulate the field in
// teardown via WebDeployment.deploymentId.
const WebDeploymentFactory = defineFactory({
    inputSchema: WebDeploymentInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.webDeployment.create({
            data: {
                deploymentId: data.deploymentId,
                organizationId: data.organizationId,
                url: data.url ?? "https://autonoma-test.example",
                file: data.file,
            },
        });
        return { id: row.deploymentId };
    },
});

const MobileDeploymentInput = loose({
    deploymentId: z.string(),
    organizationId: z.string(),
    packageUrl: z.string().optional(),
    photo: z.string().optional(),
    packageName: z.string().optional(),
});

const MobileDeploymentFactory = defineFactory({
    inputSchema: MobileDeploymentInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.mobileDeployment.create({
            data: {
                deploymentId: data.deploymentId,
                organizationId: data.organizationId,
                packageUrl: data.packageUrl ?? "s3://autonoma-test/apk.apk",
                photo: data.photo ?? "https://example.com/icon.png",
                packageName: data.packageName ?? `com.autonoma.test.${randomBytes(3).toString("hex")}`,
            },
        });
        return { id: row.deploymentId };
    },
});

const FolderInput = loose({
    name: z.string().optional(),
    applicationId: z.string(),
    organizationId: z.string(),
    parentId: z.string().optional(),
    description: z.string().optional(),
});

const FolderFactory = defineFactory({
    inputSchema: FolderInput,
    refSchema: emptyRef,
    create: async (data) => {
        // Name honored verbatim (a supplied Folder name may be referenced by a
        // test). The (applicationId, parentId, name) uniqueness is now the
        // scenario's responsibility - synthesize a suffixed name only when omitted.
        const suffix = randomBytes(3).toString("hex");
        const row = await db.folder.create({
            data: {
                name: data.name ?? `Folder ${suffix}`,
                applicationId: data.applicationId,
                organizationId: data.organizationId,
                parentId: data.parentId ?? undefined,
                description: data.description ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const InvitationInput = loose({
    organizationId: z.string(),
    inviterId: z.string(),
    email: z.string().optional(),
    role: z.string().optional(),
    status: z.string().optional(),
    expiresInSeconds: z.number().optional(),
});

const InvitationFactory = defineFactory({
    inputSchema: InvitationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const row = await db.invitation.create({
            data: {
                organizationId: data.organizationId,
                inviterId: data.inviterId,
                email: data.email ?? `invitee-${suffix}@autonoma.local`,
                role: data.role ?? "developer",
                status: data.status ?? "pending",
                expiresAt: new Date(Date.now() + (data.expiresInSeconds ?? 7 * 86400) * 1000),
            },
        });
        return { id: row.id };
    },
});

const ApiKeyInput = loose({
    userId: z.string(),
    organizationId: z.string(),
    name: z.string().optional(),
    key: z.string().optional(),
});

const ApiKeyFactory = defineFactory({
    inputSchema: ApiKeyInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(6).toString("hex");
        const row = await db.apiKey.create({
            data: {
                name: data.name ?? "Autonoma test API key",
                key: data.key ?? `aut_test_${suffix}`,
                userId: data.userId,
                organizationId: data.organizationId,
                enabled: true,
                start: "aut_test",
                prefix: "aut_",
            },
        });
        return { id: row.id };
    },
});

const PreviewkitEnvironmentInput = loose({
    organizationId: z.string(),
    branchId: z.string().optional(),
    namespace: z.string().optional(),
    repoFullName: z.string().optional(),
    prNumber: z.number().optional(),
    headSha: z.string().optional(),
    headRef: z.string().optional(),
    status: z.string().optional(),
});

const PreviewkitEnvironmentStatus = z.enum(["pending", "building", "deploying", "ready", "failed", "torn_down"]);

const PreviewkitEnvironmentFactory = defineFactory({
    inputSchema: PreviewkitEnvironmentInput,
    refSchema: emptyRef,
    // Real path (PreviewkitTriggerService.onDeploymentCreated) provisions a K8s
    // namespace — that side effect can't run locally. We recreate only the row.
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        // Uniqueness is (repoFullName, prNumber). Suffix both so repeated up
        // cycles from the same recipe never collide on a stale row that a
        // previous DOWN failed to clean up.
        const row = await db.previewkitEnvironment.create({
            data: {
                namespace: data.namespace ? `${data.namespace}-${suffix}` : `preview-autonoma-test-${suffix}`,
                repoFullName: `${data.repoFullName ?? "autonoma-ai/test-repo"}-${suffix}`,
                prNumber: (data.prNumber ?? 0) + Math.floor(Math.random() * 1_000_000),
                headSha: data.headSha ?? randomBytes(20).toString("hex"),
                headRef: data.headRef ?? `pr-${randomBytes(3).toString("hex")}`,
                status: PreviewkitEnvironmentStatus.safeParse(data.status).data ?? "ready",
                organizationId: data.organizationId,
                branchId: data.branchId ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const ScenarioInput = loose({
    applicationId: z.string(),
    organizationId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
});

const ScenarioFactory = defineFactory({
    inputSchema: ScenarioInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const row = await db.scenario.create({
            data: {
                name: data.name ?? `Scenario ${suffix}`,
                description: data.description ?? undefined,
                applicationId: data.applicationId,
                organizationId: data.organizationId,
            },
        });
        return { id: row.id };
    },
});

const ScenarioInstanceInput = loose({
    scenarioId: z.string(),
    applicationId: z.string(),
    organizationId: z.string(),
    status: z.string().optional(),
    deploymentId: z.string().optional(),
});

const ScenarioInstanceStatus = z.enum([
    "REQUESTED",
    "UP_SUCCESS",
    "UP_FAILED",
    "RUNNING_TESTS",
    "DOWN_SUCCESS",
    "DOWN_FAILED",
]);

const ScenarioInstanceFactory = defineFactory({
    inputSchema: ScenarioInstanceInput,
    refSchema: emptyRef,
    create: async (data) => {
        const status = ScenarioInstanceStatus.safeParse(data.status).data ?? "UP_SUCCESS";
        const row = await db.scenarioInstance.create({
            data: {
                scenarioId: data.scenarioId,
                applicationId: data.applicationId,
                organizationId: data.organizationId,
                status,
                deploymentId: data.deploymentId ?? undefined,
                upAt: status === "UP_SUCCESS" ? new Date() : undefined,
            },
        });
        return { id: row.id };
    },
});

const TestCaseInput = loose({
    applicationId: z.string(),
    organizationId: z.string(),
    folderId: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    shadow: z.boolean().optional(),
    description: z.string().optional(),
});

const TestCaseFactory = defineFactory({
    inputSchema: TestCaseInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const name = data.name ?? `Test Case ${suffix}`;
        const slug = slugOrSuffixed(data.slug, name, suffix);
        const row = await db.testCase.create({
            data: {
                name,
                slug,
                description: data.description ?? undefined,
                shadow: data.shadow ?? false,
                applicationId: data.applicationId,
                folderId: data.folderId,
                organizationId: data.organizationId,
            },
        });
        return { id: row.id };
    },
});

const TestPlanInput = loose({
    testCaseId: z.string(),
    organizationId: z.string(),
    prompt: z.string().optional(),
    scenarioId: z.string().optional(),
    scenarioName: z.string().optional(),
});

const TestPlanFactory = defineFactory({
    inputSchema: TestPlanInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.testPlan.create({
            data: {
                testCaseId: data.testCaseId,
                organizationId: data.organizationId,
                prompt: data.prompt ?? "Autonoma test plan",
                scenarioId: data.scenarioId ?? undefined,
                scenarioName: data.scenarioName ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const BranchSnapshotInput = loose({
    // Honored verbatim: `/…/snapshots/:snapshotId` resolves by primary id, so a
    // test that deep-links a snapshot must seed it with that exact id.
    id: z.string().optional(),
    branchId: z.string(),
    source: z.enum(["GITHUB_PUSH", "MANUAL", "WEBHOOK"]).optional(),
    status: z.enum(["processing", "active", "superseded", "failed", "cancelled"]).optional(),
    headSha: z.string().optional(),
    baseSha: z.string().optional(),
    investigationSnapshotId: z.string().optional(),
    setActiveOnBranch: z.boolean().optional(),
});

const BranchSnapshotFactory = defineFactory({
    inputSchema: BranchSnapshotInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.branchSnapshot.create({
            data: {
                id: data.id ?? undefined,
                branchId: data.branchId,
                source: data.source ?? "MANUAL",
                status: data.status ?? "active",
                headSha: data.headSha ?? randomBytes(20).toString("hex"),
                baseSha: data.baseSha ?? undefined,
                investigationSnapshotId: data.investigationSnapshotId ?? undefined,
            },
        });
        // Point the branch at this snapshot (Branch.activeSnapshotId <->
        // BranchSnapshot.branchId is circular, so it's wired post-insert).
        if (data.setActiveOnBranch === true) {
            await db.branch.update({
                where: { id: data.branchId },
                data: { activeSnapshotId: row.id },
            });
        }
        return { id: row.id };
    },
});

const TestGenerationInput = loose({
    testPlanId: z.string(),
    snapshotId: z.string(),
    organizationId: z.string(),
    status: z.enum(["pending", "queued", "running", "success", "failed"]).optional(),
    shadow: z.boolean().optional(),
});

const TestGenerationFactory = defineFactory({
    inputSchema: TestGenerationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.testGeneration.create({
            data: {
                testPlanId: data.testPlanId,
                snapshotId: data.snapshotId,
                organizationId: data.organizationId,
                status: data.status ?? "success",
                shadow: data.shadow ?? false,
            },
        });
        return { id: row.id };
    },
});

const RefinementLoopInput = loose({
    snapshotId: z.string(),
    organizationId: z.string(),
    triggeredBy: z.enum(["onboarding", "diffs"]).optional(),
    status: z.enum(["running", "converged", "max_iterations", "error"]).optional(),
});

const RefinementLoopFactory = defineFactory({
    inputSchema: RefinementLoopInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.refinementLoop.create({
            data: {
                snapshotId: data.snapshotId,
                organizationId: data.organizationId,
                triggeredBy: data.triggeredBy ?? "diffs",
                status: data.status ?? "converged",
                finishedAt: new Date(),
            },
        });
        return { id: row.id };
    },
});

const ScenarioRecipeVersionInput = loose({
    scenarioId: z.string(),
    snapshotId: z.string(),
    schemaSnapshotId: z.string().optional(),
    applicationId: z.string(),
    organizationId: z.string(),
    scenarioNameSnapshot: z.string().optional(),
    fingerprint: z.string().optional(),
    validationStatus: z.string().optional(),
    validationMethod: z.string().optional(),
    validationPhase: z.string().optional(),
    fixtureJson: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
});

const ScenarioRecipeVersionFactory = defineFactory({
    inputSchema: ScenarioRecipeVersionInput,
    refSchema: emptyRef,
    create: async (data) => {
        // A ScenarioSchemaSnapshot is required — create one on the fly when
        // the recipe doesn't ref one. Uniqueness is (applicationId, snapshotId)
        // so we upsert on that pair.
        let schemaSnapshotId = data.schemaSnapshotId;
        if (schemaSnapshotId == null) {
            const existing = await db.scenarioSchemaSnapshot.findUnique({
                where: {
                    applicationId_snapshotId: {
                        applicationId: data.applicationId,
                        snapshotId: data.snapshotId,
                    },
                },
            });
            if (existing != null) {
                schemaSnapshotId = existing.id;
            } else {
                const s = await db.scenarioSchemaSnapshot.create({
                    data: {
                        applicationId: data.applicationId,
                        snapshotId: data.snapshotId,
                        structureJson: { models: {} },
                        fingerprint: randomBytes(8).toString("hex"),
                    },
                });
                schemaSnapshotId = s.id;
            }
        }
        const row = await db.scenarioRecipeVersion.create({
            data: {
                scenarioId: data.scenarioId,
                snapshotId: data.snapshotId,
                schemaSnapshotId,
                applicationId: data.applicationId,
                organizationId: data.organizationId,
                scenarioNameSnapshot: data.scenarioNameSnapshot ?? "Autonoma test scenario",
                description: data.description ?? undefined,
                fingerprint: data.fingerprint ?? randomBytes(8).toString("hex"),
                validationStatus: data.validationStatus ?? "valid",
                validationMethod: data.validationMethod ?? "up-down",
                validationPhase: data.validationPhase ?? "discovery",
                fixtureJson: {
                    name: data.scenarioNameSnapshot ?? "Autonoma test scenario",
                    description: data.description ?? "Autonoma seeded recipe version",
                    create: {},
                    validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                },
            },
        });
        return { id: row.id };
    },
});

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

export const autonomaFactories = {
    Organization: OrganizationFactory,
    User: UserFactory,
    Verification: VerificationFactory,
    Jwks: JwksFactory,
    OauthApplication: OauthApplicationFactory,
    BillingPromoCode: BillingPromoCodeFactory,
    BenchmarkBatch: BenchmarkBatchFactory,
    Application: ApplicationFactory,
    ApplicationSetup: ApplicationSetupFactory,
    OnboardingState: OnboardingStateFactory,
    Branch: BranchFactory,
    FeatureBranchInfo: FeatureBranchInfoFactory,
    BranchDeployment: BranchDeploymentFactory,
    WebDeployment: WebDeploymentFactory,
    MobileDeployment: MobileDeploymentFactory,
    Folder: FolderFactory,
    Invitation: InvitationFactory,
    ApiKey: ApiKeyFactory,
    PreviewkitEnvironment: PreviewkitEnvironmentFactory,
    Scenario: ScenarioFactory,
    ScenarioInstance: ScenarioInstanceFactory,
    TestCase: TestCaseFactory,
    TestPlan: TestPlanFactory,
    BranchSnapshot: BranchSnapshotFactory,
    TestGeneration: TestGenerationFactory,
    RefinementLoop: RefinementLoopFactory,
    ScenarioRecipeVersion: ScenarioRecipeVersionFactory,
};
