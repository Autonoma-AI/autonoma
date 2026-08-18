import { randomBytes, randomUUID } from "node:crypto";
import { defineFactory } from "@autonoma-ai/sdk";
import {
    AnalysisJobStatus,
    CreditTransactionType as CreditTransactionTypeEnum,
    OnboardingPreviewVerificationStatus as OnboardingPreviewVerificationStatusEnum,
    OnboardingStep as OnboardingStepEnum,
    PreviewkitAppStatus as PreviewkitAppStatusEnum,
    PreviewkitStatus,
    previewkitConfigCreateChildren,
    SubscriptionStatus as SubscriptionStatusEnum,
    VercelInstallationStatus,
    db,
} from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import {
    analysisFlowSchema,
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
    evidenceManifestEntrySchema,
    hasGoneLive,
    PREVIEW_CONFIG_VERSION,
    previewkitConfigRowValues,
    primaryScreenshotSchema,
    suspectedCauseSchema,
    trustedPreviewConfigSchema,
} from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import { z } from "zod";

const logger = rootLogger.child({ name: "AutonomaSdkFactories" });

/** `PreviewkitAppInstance.port` is required; a recipe that omits it gets the usual web port. */
const DEFAULT_PREVIEW_APP_PORT = 3000;

/** Wallet defaults for a seeded tenant - enough that no billing screen renders an out-of-credits state. */
const DEFAULT_CREDIT_BALANCE = 50_000;
const DEFAULT_SUBSCRIPTION_CREDITS = 40_000;

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

/**
 * A `Json` column a recipe fills verbatim (a previewkit topology, an evidence
 * manifest, a step trace). Validated at the boundary rather than passed through
 * untyped, so a malformed document fails the `up` with a field path instead of
 * a Prisma error thrown from inside the driver.
 */
const JsonDocument = z.record(z.string(), z.json());

/**
 * The analysis `Json` columns are typed in the Prisma schema (`/// [EvidenceManifest]`
 * and friends), so a recipe filling one has to match that shape or the write does
 * not compile. Reuse the schemas those annotations name rather than restating them
 * here - a drift between the two would only show up as a runtime read failure in
 * the UI.
 */
const EvidenceManifest = z.array(evidenceManifestEntrySchema);
const AnalysisFlows = z.array(analysisFlowSchema);
const AnalysisCoverage = z.object({
    total: z.number(),
    byCategory: z.array(z.object({ category: z.string(), count: z.number() })),
});

/**
 * Zod views of the Prisma enums these factories write, derived from the generated enum objects
 * rather than re-listed. A hand-copy is only checked for *valid members*, never for staying in
 * sync: a new member added to the Prisma enum is silently invisible here, `safeParse` fails, and
 * the default fires with no compile error. That already happened - `superseded` was missing from
 * the previewkit status list, so a recipe seeding a superseded build silently got `ready`.
 */
const OnboardingStep = z.enum(OnboardingStepEnum);
const OnboardingPreviewVerificationStatus = z.enum(OnboardingPreviewVerificationStatusEnum);
const SubscriptionStatus = z.enum(SubscriptionStatusEnum);
const CreditTransactionType = z.enum(CreditTransactionTypeEnum);
const VercelInstallationStatusSchema = z.enum(VercelInstallationStatus);
const PreviewkitStatusSchema = z.enum(PreviewkitStatus);
const PreviewkitAppStatus = z.enum(PreviewkitAppStatusEnum);
const AnalysisJobStatusSchema = z.enum(AnalysisJobStatus);

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
    // Honored verbatim, like BranchSnapshot.id: the onboarding flow addresses an
    // application by primary id (`/onboarding?appId=…`), not by slug, so a test
    // that deep-links into onboarding needs the id it can write down. Everything
    // under `/app/:slug` resolves by slug instead - that one is honored below.
    id: z.string().optional(),
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
                id: data.id ?? undefined,
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

// Application creation seeds an OnboardingState row; the app's list gate only checks
// app-count, but the Finish-setup / SDK-validation screens read this. Defaults describe a
// finished tenant, which is what most scenarios want.
//
// A scenario that wants the OPPOSITE - an app still mid-setup, so the
// Finish-setup wizard is reachable - must set `step` to an earlier value AND
// seed no Scenario and no TestCase for the application. OnboardingManager.getState
// treats content as proof of completion (`hasContent && !artifactsUploaded`), so an
// early `step` alone still redirects /finish-setup to the app overview.
const OnboardingStateInput = loose({
    applicationId: z.string(),
    productionUrl: z.string().optional(),
    previewUrl: z.string().optional(),
    step: z.string().optional(),
    previewVerificationStatus: z.string().optional(),
    completed: z.boolean().optional(),
    dryRunPassed: z.boolean().optional(),
});

const OnboardingStateFactory = defineFactory({
    inputSchema: OnboardingStateInput,
    refSchema: emptyRef,
    create: async (data) => {
        const now = new Date();
        const step = OnboardingStep.safeParse(data.step).data ?? "completed";
        const row = await db.onboardingState.create({
            data: {
                applicationId: data.applicationId,
                step,
                completedAt: (data.completed ?? hasGoneLive(step)) ? now : undefined,
                dryRunPassedAt: (data.dryRunPassed ?? hasGoneLive(step)) ? now : undefined,
                previewVerificationStatus:
                    OnboardingPreviewVerificationStatus.safeParse(data.previewVerificationStatus).data ?? "ready",
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

const MemberInput = loose({
    organizationId: z.string(),
    userId: z.string(),
    role: z.string().optional(),
});

/**
 * Who belongs to the seeded organization.
 *
 * Without this, the only membership an app ever had was the one the SDK's auth callback
 * upserts for whoever signs in - so every seeded organization had exactly one member, the
 * agent itself, and no test could reach anything that needs a second person: removing a
 * member, a colleague's API key, an organization somebody can leave.
 *
 * Upserted rather than created because that same auth callback races this: it makes the
 * signing-in user a member too, and a recipe naming that user would otherwise collide on
 * `(userId, organizationId)`.
 */
const MemberFactory = defineFactory({
    inputSchema: MemberInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.member.upsert({
            where: { userId_organizationId: { userId: data.userId, organizationId: data.organizationId } },
            update: {},
            create: {
                userId: data.userId,
                organizationId: data.organizationId,
                role: data.role ?? "member",
            },
        });
        logger.info("Created member", {
            organizationId: data.organizationId,
            extra: { memberId: row.id, userId: data.userId, role: row.role },
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

// ─────────────────────────────────────────────────────────────────────────
// Billing. BillingCustomer is the org's wallet; CreditTransaction joins to it
// by organizationId (not by its own id), so a scenario that seeds transactions
// must seed the customer too.
// ─────────────────────────────────────────────────────────────────────────

const BillingCustomerInput = loose({
    organizationId: z.string(),
    creditBalance: z.number().optional(),
    subscriptionCreditBalance: z.number().optional(),
    subscriptionStatus: z.string().optional(),
    autoTopUpEnabled: z.boolean().optional(),
    autoTopUpThreshold: z.number().optional(),
});

const BillingCustomerFactory = defineFactory({
    inputSchema: BillingCustomerInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(6).toString("hex");
        const row = await db.billingCustomer.create({
            data: {
                organizationId: data.organizationId,
                // Globally unique. Never a real Stripe id - these tenants must
                // never resolve against the live Stripe account.
                stripeCustomerId: `cus_autonoma_test_${suffix}`,
                creditBalance: data.creditBalance ?? DEFAULT_CREDIT_BALANCE,
                subscriptionCreditBalance: data.subscriptionCreditBalance ?? DEFAULT_SUBSCRIPTION_CREDITS,
                subscriptionStatus: SubscriptionStatus.safeParse(data.subscriptionStatus).data ?? "active",
                autoTopUpEnabled: data.autoTopUpEnabled ?? false,
                autoTopUpThreshold: data.autoTopUpThreshold ?? 0,
            },
        });
        return { id: row.id };
    },
});

const CreditTransactionInput = loose({
    organizationId: z.string(),
    type: z.string().optional(),
    amount: z.number().optional(),
    balanceAfter: z.number().optional(),
});

const CreditTransactionFactory = defineFactory({
    inputSchema: CreditTransactionInput,
    refSchema: emptyRef,
    create: async (data) => {
        const amount = data.amount ?? DEFAULT_SUBSCRIPTION_CREDITS;
        const row = await db.creditTransaction.create({
            data: {
                organizationId: data.organizationId,
                type: CreditTransactionType.safeParse(data.type).data ?? "SUBSCRIPTION_GRANT",
                amount,
                balanceAfter: data.balanceAfter ?? amount,
            },
        });
        return { id: row.id };
    },
});

// ─────────────────────────────────────────────────────────────────────────
// Vercel. The chain the UI walks is
// VercelInstallation -> VercelProject -> VercelProjectConnection -> Application,
// so the onboarding "select a deployment" step shows nothing unless all four
// exist. VercelDeployment hangs off the connection.
// ─────────────────────────────────────────────────────────────────────────

const VercelInstallationInput = loose({
    organizationId: z.string(),
    userId: z.string(),
    vercelInstallationId: z.string().optional(),
    vercelAccountId: z.string().optional(),
    vercelUserId: z.string().optional(),
    status: z.string().optional(),
    maxOverageAmountUsd: z.number().optional(),
});

const VercelInstallationFactory = defineFactory({
    inputSchema: VercelInstallationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(6).toString("hex");
        const row = await db.vercelInstallation.create({
            data: {
                // Globally unique - a scenario templating this with {testRunId}
                // is what keeps concurrent runs apart; the fallback covers recipes
                // that do not care.
                vercelInstallationId: data.vercelInstallationId ?? `icfg_autonoma_test_${suffix}`,
                vercelAccountId: data.vercelAccountId ?? `team_autonoma_test_${suffix}`,
                vercelUserId: data.vercelUserId ?? `user_autonoma_test_${suffix}`,
                organizationId: data.organizationId,
                userId: data.userId,
                status: VercelInstallationStatusSchema.safeParse(data.status).data ?? "active",
                maxOverageAmountUsd: data.maxOverageAmountUsd ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const VercelProjectInput = loose({
    vercelInstallationId: z.string(),
    name: z.string().optional(),
    vercelProjectId: z.string().optional(),
    productionUrl: z.string().optional(),
    githubRepositoryId: z.number().optional(),
});

const VercelProjectFactory = defineFactory({
    inputSchema: VercelProjectInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(6).toString("hex");
        const row = await db.vercelProject.create({
            data: {
                // `vercelInstallationId` here is the local VercelInstallation row id
                // (the FK), not Vercel's own installation id - the recipe passes a
                // _ref, so it resolves to the row.
                vercelInstallationId: data.vercelInstallationId,
                vercelProjectId: data.vercelProjectId ?? `prj_autonoma_test_${suffix}`,
                name: data.name ?? `autonoma-test-project-${suffix}`,
                productionUrl: data.productionUrl ?? undefined,
                githubRepositoryId: data.githubRepositoryId ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const VercelProjectConnectionInput = loose({
    projectId: z.string(),
    applicationId: z.string(),
});

const VercelProjectConnectionFactory = defineFactory({
    inputSchema: VercelProjectConnectionInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.vercelProjectConnection.create({
            data: {
                projectId: data.projectId,
                applicationId: data.applicationId,
            },
        });
        return { id: row.id };
    },
});

const VercelDeploymentInput = loose({
    projectConnectionId: z.string(),
    branchSnapshotId: z.string().optional(),
    vercelDeploymentId: z.string().optional(),
    vercelCheckRunId: z.string().optional(),
});

const VercelDeploymentFactory = defineFactory({
    inputSchema: VercelDeploymentInput,
    refSchema: emptyRef,
    create: async (data) => {
        const suffix = randomBytes(6).toString("hex");
        const row = await db.vercelDeployment.create({
            data: {
                vercelDeploymentId: data.vercelDeploymentId ?? `dpl_autonoma_test_${suffix}`,
                vercelCheckRunId: data.vercelCheckRunId ?? `check_autonoma_test_${suffix}`,
                projectConnectionId: data.projectConnectionId,
                branchSnapshotId: data.branchSnapshotId ?? undefined,
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
    githubRepositoryId: z.number().optional(),
    headSha: z.string().optional(),
    headRef: z.string().optional(),
    status: z.string().optional(),
    phase: z.string().optional(),
    urls: z.record(z.string(), z.string()).optional(),
    resolvedConfig: JsonDocument.optional(),
    deployed: z.boolean().optional(),
});

const PreviewkitEnvironmentFactory = defineFactory({
    inputSchema: PreviewkitEnvironmentInput,
    refSchema: emptyRef,
    // Real path (PreviewkitTriggerService.onDeploymentCreated) provisions a K8s
    // namespace — that side effect can't run locally. We recreate only the row.
    //
    // `githubRepositoryId` + `prNumber` are the lookup key: DeploymentsService
    // .previewSummaryByPr resolves the branch by prInfo.prNumber, then matches
    // previewkitEnvironment on { organizationId, githubRepositoryId, prNumber }.
    // Both must equal what the recipe put on the Application and the
    // FeatureBranchInfo, or the PR's Preview tab renders "No preview environment
    // for this pull request". They are therefore honored verbatim, per the
    // verbatim-identifier rule at the top of this file. `namespace` and
    // (repoFullName, prNumber) are globally unique, but neither the namespace nor
    // repoFullName is part of the lookup - so a scenario buys cross-run
    // uniqueness by templating those two with {testRunId}, never by mangling
    // prNumber here.
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const row = await db.previewkitEnvironment.create({
            data: {
                namespace: data.namespace ?? `preview-autonoma-test-${suffix}`,
                repoFullName: data.repoFullName ?? `autonoma-ai/test-repo-${suffix}`,
                prNumber: data.prNumber ?? 0,
                githubRepositoryId: data.githubRepositoryId ?? undefined,
                headSha: data.headSha ?? randomBytes(20).toString("hex"),
                headRef: data.headRef ?? `pr-${randomBytes(3).toString("hex")}`,
                status: PreviewkitStatusSchema.safeParse(data.status).data ?? "ready",
                phase: data.phase ?? undefined,
                urls: data.urls ?? {},
                resolvedConfig: data.resolvedConfig ?? undefined,
                deployedAt: (data.deployed ?? true) ? new Date() : undefined,
                organizationId: data.organizationId,
                branchId: data.branchId ?? undefined,
            },
        });
        return { id: row.id };
    },
});

// No organizationId: PreviewkitConfig hangs off Application only, and cascades
// through it when the seeded org goes.
const PreviewkitConfigInput = loose({
    applicationId: z.string(),
    document: JsonDocument.optional(),
});

/**
 * A seeded config has to name at least one app. The schema has always required it,
 * and every reader composes the config from the topology rows, so a row seeded with
 * no apps is one they all read as empty - the workspace page this factory exists to
 * populate included.
 */
const SEEDED_PREVIEW_DOCUMENT = {
    version: PREVIEW_CONFIG_VERSION,
    apps: [{ name: "web", repository: "autonoma/seeded-preview", port: 3000, primary: true }],
};

const PreviewkitConfigFactory = defineFactory({
    inputSchema: PreviewkitConfigInput,
    refSchema: emptyRef,
    // The preview-config workspace reads this row (loadSavedConfigAppIndexes in
    // onboarding/preview-readiness.ts). With no row the page renders
    // "We couldn't load this." - there is no empty state for a missing config.
    //
    // Written the way the authoring API writes it: parsed, then decomposed into the
    // topology rows readers serve.
    create: async (data) => {
        const config = trustedPreviewConfigSchema.parse(data.document ?? SEEDED_PREVIEW_DOCUMENT);
        const row = await db.previewkitConfig.create({
            data: {
                applicationId: data.applicationId,
                ...previewkitConfigCreateChildren(previewkitConfigRowValues(config)),
            },
        });
        return { id: row.id };
    },
});

const PreviewkitAppInstanceInput = loose({
    environmentId: z.string(),
    appName: z.string().optional(),
    status: z.string().optional(),
    imageTag: z.string().optional(),
    url: z.string().optional(),
    port: z.number().optional(),
    error: z.string().optional(),
});

const PreviewkitAppInstanceFactory = defineFactory({
    inputSchema: PreviewkitAppInstanceInput,
    refSchema: emptyRef,
    // One row per service in the preview. These are what the environment
    // explorer's services rail lists (PREVIEWKIT_SUMMARY_ENV_SELECT.appInstances).
    create: async (data) => {
        const suffix = randomBytes(3).toString("hex");
        const appName = data.appName ?? `app-${suffix}`;
        // An instance hangs off the app row, so the topology has to name this app
        // before there is anywhere to record a deployment of it. An environment has
        // no foreign key to its application - it is matched on repository, scoped by
        // organization, since a repository id is unique only within an org.
        const environment = await db.previewkitEnvironment.findUniqueOrThrow({
            where: { id: data.environmentId },
            select: { organizationId: true, githubRepositoryId: true },
        });
        const app = await db.previewkitApp.findFirstOrThrow({
            where: {
                name: appName,
                config: {
                    application: {
                        organizationId: environment.organizationId,
                        githubRepositoryId: environment.githubRepositoryId,
                    },
                },
            },
            select: { id: true },
        });
        const row = await db.previewkitAppInstance.create({
            data: {
                environmentId: data.environmentId,
                appName,
                appId: app.id,
                status: PreviewkitAppStatus.safeParse(data.status).data ?? "ready",
                imageTag: data.imageTag ?? undefined,
                url: data.url ?? undefined,
                port: data.port ?? DEFAULT_PREVIEW_APP_PORT,
                error: data.error ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const PreviewkitBuildInput = loose({
    environmentId: z.string(),
    headSha: z.string().optional(),
    status: z.string().optional(),
});

const PreviewkitBuildFactory = defineFactory({
    inputSchema: PreviewkitBuildInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.previewkitBuild.create({
            data: {
                environmentId: data.environmentId,
                headSha: data.headSha ?? randomBytes(20).toString("hex"),
                status: PreviewkitStatusSchema.safeParse(data.status).data ?? "ready",
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
            },
        });
        return { id: row.id };
    },
});

// ─────────────────────────────────────────────────────────────────────────
// Analysis pipeline: what a PR's report, findings and evidence are read from.
// Seed order matters and mirrors the FKs:
//   AnalysisJob (keyed by snapshot) -> AnalysisFinding -> AnalysisClassification
// with AnalysisReport keyed by the same snapshot and AnalysisIssue keyed by the
// branch. A finding's FK points at AnalysisJob.snapshotId, NOT AnalysisReport -
// seeding only a report leaves every finding unattachable.
// ─────────────────────────────────────────────────────────────────────────

const AnalysisJobInput = loose({
    snapshotId: z.string(),
    organizationId: z.string(),
    status: z.string().optional(),
    failureReason: z.string().optional(),
    impactReasoning: z.string().optional(),
});

const AnalysisJobFactory = defineFactory({
    inputSchema: AnalysisJobInput,
    refSchema: emptyRef,
    create: async (data) => {
        const now = new Date();
        const row = await db.analysisJob.create({
            data: {
                snapshotId: data.snapshotId,
                organizationId: data.organizationId,
                status: AnalysisJobStatusSchema.safeParse(data.status).data ?? "completed",
                failureReason: data.failureReason ?? undefined,
                impactReasoning: data.impactReasoning ?? undefined,
                startedAt: now,
                completedAt: now,
            },
        });
        // snapshotId is the primary key - return it so `_ref`s resolve.
        return { id: row.snapshotId };
    },
});

// `title` and `headline` are what the Reporter authors; `headline` is the column still named
// `summary`. Both are NOT NULL with no default on purpose - a writer that forgets `title` must fail
// rather than persist '', which every reader takes to mean "a report from before the Reporter
// existed". A seeded report is standing in for an authored one, so it supplies both.
const AnalysisReportInput = loose({
    snapshotId: z.string(),
    organizationId: z.string(),
    verdict: z.string().optional(),
    testCount: z.number().optional(),
    clientBugCount: z.number().optional(),
    title: z.string().optional(),
    headline: z.string().optional(),
    reportMarkdown: z.string().optional(),
    coverage: AnalysisCoverage.optional(),
    flows: AnalysisFlows.optional(),
    evidenceManifest: EvidenceManifest.optional(),
});

const AnalysisReportFactory = defineFactory({
    inputSchema: AnalysisReportInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.analysisReport.create({
            data: {
                snapshotId: data.snapshotId,
                organizationId: data.organizationId,
                verdict: data.verdict ?? "passed",
                testCount: data.testCount ?? 0,
                clientBugCount: data.clientBugCount ?? 0,
                title: data.title ?? "Seeded report for a test tenant",
                headline: data.headline ?? "Seeded by the Autonoma SDK test-data endpoint.",
                reportMarkdown: data.reportMarkdown ?? "## Seeded report\n\nNo real analysis ran for this tenant.",
                coverage: data.coverage ?? undefined,
                flows: data.flows ?? undefined,
                evidenceManifest: data.evidenceManifest ?? undefined,
            },
        });
        return { id: row.snapshotId };
    },
});

const AnalysisIssueInput = loose({
    // Honored verbatim: an analysis issue is deep-linked by primary id from the
    // PR comment ("What to fix" links straight to /issues/:id).
    id: z.string().optional(),
    branchId: z.string(),
    organizationId: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    severity: z.string().optional(),
    status: z.string().optional(),
    expectedBehavior: z.string().optional(),
    actualBehavior: z.string().optional(),
    narrativeMarkdown: z.string().optional(),
    primaryTestCaseId: z.string().optional(),
    evidenceManifest: EvidenceManifest.optional(),
    primaryScreenshot: primaryScreenshotSchema.optional(),
    suspectedCause: suspectedCauseSchema.optional(),
});

const AnalysisIssueFactory = defineFactory({
    inputSchema: AnalysisIssueInput,
    refSchema: emptyRef,
    // The authored content lives on an AnalysisIssueVersion; the issue holds only its identity + lifecycle. Seed the
    // issue, its one version, then point `currentVersion` at that version - the same three writes the Reporter makes.
    create: async (data) => {
        const issue = await db.analysisIssue.create({
            data: {
                id: data.id ?? undefined,
                branchId: data.branchId,
                organizationId: data.organizationId,
                status: data.status ?? "open",
            },
        });
        const version = await db.analysisIssueVersion.create({
            data: {
                issueId: issue.id,
                organizationId: data.organizationId,
                title: data.title ?? "Autonoma test analysis issue",
                kind: analysisIssueKindSchema.safeParse(data.kind).data ?? "bug",
                severity: analysisIssueSeveritySchema.safeParse(data.severity).data ?? "medium",
                expectedBehavior: data.expectedBehavior ?? undefined,
                actualBehavior: data.actualBehavior ?? "seeded by the Autonoma SDK test-data endpoint",
                narrativeMarkdown: data.narrativeMarkdown ?? "Seeded by the Autonoma SDK test-data endpoint.",
                primaryTestCaseId: data.primaryTestCaseId ?? undefined,
                evidenceManifest: data.evidenceManifest ?? undefined,
                primaryScreenshot: data.primaryScreenshot ?? undefined,
                suspectedCause: data.suspectedCause ?? undefined,
            },
        });
        await db.analysisIssue.update({ where: { id: issue.id }, data: { currentVersionId: version.id } });
        return { id: issue.id };
    },
});

const AnalysisFindingInput = loose({
    // The FK target is AnalysisJob.snapshotId, so this must reference a seeded
    // AnalysisJob - not an AnalysisReport that happens to share the snapshot.
    reportSnapshotId: z.string(),
    testCaseId: z.string(),
    organizationId: z.string(),
    origin: z.string().optional(),
    selectionReason: z.string().optional(),
    issueId: z.string().optional(),
});

const AnalysisFindingFactory = defineFactory({
    inputSchema: AnalysisFindingInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.analysisFinding.create({
            data: {
                reportSnapshotId: data.reportSnapshotId,
                testCaseId: data.testCaseId,
                organizationId: data.organizationId,
                origin: data.origin ?? "pre_existing",
                selectionReason: data.selectionReason ?? undefined,
                issueId: data.issueId ?? undefined,
            },
        });
        return { id: row.id };
    },
});

const AnalysisClassificationInput = loose({
    findingId: z.string(),
    generationId: z.string(),
    organizationId: z.string(),
    number: z.number().optional(),
    category: z.string().optional(),
    confidence: z.string().optional(),
    headline: z.string().optional(),
    whatHappened: z.string().optional(),
    runSuccess: z.boolean().optional(),
    stepCount: z.number().optional(),
    current: z.boolean().optional(),
});

const AnalysisClassificationFactory = defineFactory({
    inputSchema: AnalysisClassificationInput,
    refSchema: emptyRef,
    create: async (data) => {
        const row = await db.analysisClassification.create({
            data: {
                findingId: data.findingId,
                generationId: data.generationId,
                organizationId: data.organizationId,
                number: data.number ?? 1,
                category: data.category ?? "passed",
                confidence: data.confidence ?? "high",
                headline: data.headline ?? "Seeded by the Autonoma SDK test-data endpoint",
                whatHappened: data.whatHappened ?? undefined,
                runSuccess: data.runSuccess ?? true,
                stepCount: data.stepCount ?? 0,
            },
        });
        // AnalysisFinding.currentClassificationId is the pointer every read goes
        // through - a finding whose pointer is null renders as having no verdict.
        // Circular with the row above, so it is wired post-insert.
        if (data.current ?? true) {
            await db.analysisFinding.update({
                where: { id: data.findingId },
                data: { currentClassificationId: row.id },
            });
        }
        return { id: row.id };
    },
});

const TestCaseAssignmentInput = loose({
    snapshotId: z.string(),
    testCaseId: z.string(),
    planId: z.string().optional(),
});

const TestCaseAssignmentFactory = defineFactory({
    inputSchema: TestCaseAssignmentInput,
    refSchema: emptyRef,
    // Without this the PR overview reports "No tests have run for this PR yet",
    // whatever else is seeded: it is the join that puts a test case ON a snapshot.
    create: async (data) => {
        const row = await db.testCaseAssignment.create({
            data: {
                snapshotId: data.snapshotId,
                testCaseId: data.testCaseId,
                planId: data.planId ?? undefined,
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
    Member: MemberFactory,
    Invitation: InvitationFactory,
    ApiKey: ApiKeyFactory,
    BillingCustomer: BillingCustomerFactory,
    CreditTransaction: CreditTransactionFactory,
    VercelInstallation: VercelInstallationFactory,
    VercelProject: VercelProjectFactory,
    VercelProjectConnection: VercelProjectConnectionFactory,
    VercelDeployment: VercelDeploymentFactory,
    PreviewkitEnvironment: PreviewkitEnvironmentFactory,
    PreviewkitConfig: PreviewkitConfigFactory,
    PreviewkitAppInstance: PreviewkitAppInstanceFactory,
    PreviewkitBuild: PreviewkitBuildFactory,
    Scenario: ScenarioFactory,
    ScenarioInstance: ScenarioInstanceFactory,
    TestCase: TestCaseFactory,
    TestPlan: TestPlanFactory,
    BranchSnapshot: BranchSnapshotFactory,
    TestGeneration: TestGenerationFactory,
    TestCaseAssignment: TestCaseAssignmentFactory,
    AnalysisJob: AnalysisJobFactory,
    AnalysisReport: AnalysisReportFactory,
    AnalysisIssue: AnalysisIssueFactory,
    AnalysisFinding: AnalysisFindingFactory,
    AnalysisClassification: AnalysisClassificationFactory,
    ScenarioRecipeVersion: ScenarioRecipeVersionFactory,
};
