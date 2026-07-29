import type { Prisma, PrismaClient } from "@autonoma/db";
import { APIError, BadRequestError, NotFoundError } from "@autonoma/errors";
import {
    type EncryptionHelper,
    ScenarioRecipeStore,
    provisionScenarioInstance,
    teardownScenarioInstance,
} from "@autonoma/scenario";
import type { AuthPayload, Refs, ScenarioVariableScalar } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { env } from "../../env";
import { Service } from "../service";
import { derivePreviewSdkUrl } from "./preview-sdk-url";
import {
    parseStringRecord,
    projectManifest,
    resolveDeclaredSdkAppUrl,
    resolvePrimaryUrl,
    resolveSdkAppUrl,
} from "./preview-summary";

// The tenant provision/teardown are synchronous requests through the ALB, whose
// idle timeout defaults to 60s: hold the connection longer with no bytes flowing
// and the ALB returns an HTML 504 that the tRPC client can't parse. So cap the
// SDK call safely under 60s - a warm preview answers in seconds; a cold one
// (scaled to zero behind Gatekeeper) fails with a clean "timed out" the caller
// can retry, by which point the first attempt has already woken it.
const PROVISION_SDK_TIMEOUT_MS = 50_000;

export interface EnvFactoryOptions {
    applicationId: string | undefined;
    applicationName: string | undefined;
    scenarios: Array<{ id: string; name: string }>;
    appUrls: Array<{ appName: string; url: string }>;
    suggestedSdkUrl: string | undefined;
    /** The preview's primary app URL - the target of the customer "Open preview" action. */
    previewUrl: string | undefined;
    /** Set when the environment cannot run a manual up (and why). */
    disabledReason: string | undefined;
}

interface ProvisionForAppInput {
    applicationId: string;
    environmentId: string;
    scenarioId: string;
    organizationId: string;
}

interface TeardownForAppInput {
    applicationId: string;
    environmentId: string;
    scenarioId: string;
    instanceId: string;
    organizationId: string;
    refs?: Refs;
    refsToken?: string;
}

interface UpInput {
    environmentId: string;
    scenarioId: string;
    sdkUrl: string;
    timeoutMs?: number;
}

interface DownInput {
    environmentId: string;
    scenarioId: string;
    sdkUrl: string;
    instanceId: string;
    refs?: Refs;
    refsToken?: string;
    timeoutMs?: number;
}

export interface UpResult {
    instanceId: string;
    auth: AuthPayload | undefined;
    refs: Record<string, unknown> | undefined;
    refsToken: string | undefined;
    resolvedVariables: Record<string, ScenarioVariableScalar>;
}

/**
 * Resolved context for a manual Environment Factory call against a specific
 * preview environment: the owning Application, its decrypted signing secret,
 * and the headers (incl. the Gatekeeper bypass) needed to reach the preview.
 */
interface ResolvedContext {
    applicationId: string;
    signingSecret: string;
    customHeaders: Record<string, string> | undefined;
}

/**
 * Admin-only manual Environment Factory ("up"/"down") against a single preview
 * environment. Lets us seed data into a preview and pull back its credentials /
 * cookies so we can reproduce a failed test by hand, then tear the data down.
 *
 * Everything is in-memory: it uses the DB-free `provisionScenarioInstance` /
 * `teardownScenarioInstance` helpers, so no `ScenarioInstance` or `WebhookCall`
 * rows are written. The caller (admin UI) holds the `instanceId` / `refs` /
 * `refsToken` returned by `up` and passes them back to `down`.
 */
export class PreviewkitEnvFactoryService extends Service {
    private readonly recipeStore: ScenarioRecipeStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        super();
        this.recipeStore = new ScenarioRecipeStore(db);
    }

    /**
     * Resolve everything the admin popover needs for a preview environment: the
     * owning Application, its scenarios that have an active recipe, the preview's
     * app URLs, and a suggested SDK URL (the app the config declares as the SDK
     * host, else the preview branch's persisted SDK endpoint, else the primary
     * origin + the main-branch webhook path). Returns a `disabledReason` instead of
     * throwing when a manual up cannot be run.
     */
    async getOptions(environmentId: string): Promise<EnvFactoryOptions> {
        this.logger.info("Resolving previewkit env-factory options", { environmentId });

        const environment = await this.db.previewkitEnvironment.findUnique({
            where: { id: environmentId },
            select: {
                id: true,
                organizationId: true,
                githubRepositoryId: true,
                urls: true,
                resolvedConfig: true,
                // The SDK endpoint the diffs trigger persisted for this preview. Used
                // when the config declares no SDK host, and still ahead of the
                // primary-origin derivation, which assumes the handler lives on the
                // primary (front) app - untrue when it's a separate service.
                branch: { select: { deployment: { select: { webhookUrl: true } } } },
            },
        });
        if (environment == null) {
            throw new NotFoundError("Preview environment not found");
        }

        const urls = parseStringRecord(environment.urls);
        const manifest = projectManifest(environment.resolvedConfig);
        const primaryUrl = resolvePrimaryUrl(manifest, urls);
        const appUrls = Object.entries(urls).map(([appName, url]) => ({ appName, url }));

        const disabled = (disabledReason: string): EnvFactoryOptions => ({
            applicationId: undefined,
            applicationName: undefined,
            scenarios: [],
            appUrls,
            suggestedSdkUrl: undefined,
            previewUrl: primaryUrl ?? undefined,
            disabledReason,
        });

        if (environment.githubRepositoryId == null) {
            return disabled("This environment is not linked to a GitHub repository.");
        }

        const application = await this.db.application.findFirst({
            where: { githubRepositoryId: environment.githubRepositoryId, organizationId: environment.organizationId },
            select: {
                id: true,
                name: true,
                signingSecretEnc: true,
                mainBranch: { select: { deployment: { select: { webhookUrl: true } } } },
            },
        });
        if (application == null) {
            return disabled("No application is linked to this repository in this organization.");
        }
        if (application.signingSecretEnc == null) {
            return disabled("The linked application has no signing secret configured.");
        }

        const scenarios = await this.db.scenario.findMany({
            where: { applicationId: application.id, isDisabled: false, activeRecipeVersionId: { not: null } },
            orderBy: { name: "asc" },
            select: { id: true, name: true },
        });
        if (scenarios.length === 0) {
            return disabled("The linked application has no scenarios with a recipe. Run discover first.");
        }

        // An app this env's own resolved config DECLARES as the SDK host outranks the
        // endpoint persisted on the branch deployment: that row is written by whichever
        // diffs trigger ran (and on the main branch it can be an endpoint from a
        // long-gone deploy), so it is the older, weaker statement of where the handler
        // lives. Absent a declaration, the persisted endpoint stands - it may encode a
        // deliberate override - and last comes the origin-derived guess for an env with
        // no branch deployment yet (e.g. main-branch env 0).
        const mainWebhookUrl = application.mainBranch?.deployment?.webhookUrl;
        const declaredSdkAppUrl = resolveDeclaredSdkAppUrl(manifest, urls);
        const declaredSdkUrl =
            declaredSdkAppUrl != null ? derivePreviewSdkUrl(declaredSdkAppUrl, mainWebhookUrl) : undefined;
        const persistedSdkUrl = environment.branch?.deployment?.webhookUrl ?? undefined;
        const derivedSdkUrl = derivePreviewSdkUrl(resolveSdkAppUrl(manifest, urls), mainWebhookUrl);

        const suggestedSdkUrl = declaredSdkUrl ?? persistedSdkUrl ?? derivedSdkUrl;
        if (suggestedSdkUrl == null) {
            return disabled("This environment has no app URL to target yet.");
        }

        this.logger.info("Resolved previewkit env-factory options", {
            environmentId,
            applicationId: application.id,
            scenarioCount: scenarios.length,
        });

        return {
            applicationId: application.id,
            applicationName: application.name,
            scenarios,
            appUrls,
            suggestedSdkUrl,
            previewUrl: primaryUrl ?? undefined,
            disabledReason: undefined,
        };
    }

    /**
     * Customer-facing counterpart to `getOptions`, scoped to an application the
     * caller owns. Authorizes the environment against the app + organization,
     * then returns the same options payload.
     */
    async getOptionsForApp(
        applicationId: string,
        environmentId: string,
        organizationId: string,
    ): Promise<EnvFactoryOptions> {
        this.logger.info("Resolving test-user options", { applicationId, environmentId, organizationId });
        await this.assertEnvironmentBelongsToApp(environmentId, applicationId, organizationId);
        return this.getOptions(environmentId);
    }

    /**
     * Customer-facing "up": provision a throwaway test user for a preview
     * environment the caller owns. Authorizes first, derives the SDK URL
     * server-side (never trusting a client-supplied host), then delegates to
     * `up`. In-memory only - nothing is persisted.
     */
    async provisionForApp(input: ProvisionForAppInput): Promise<UpResult> {
        this.logger.info("Provisioning test user", {
            applicationId: input.applicationId,
            environmentId: input.environmentId,
            scenarioId: input.scenarioId,
        });
        await this.assertEnvironmentBelongsToApp(input.environmentId, input.applicationId, input.organizationId);
        const sdkUrl = await this.resolveSdkUrl(input.environmentId);
        try {
            return await this.up({
                environmentId: input.environmentId,
                scenarioId: input.scenarioId,
                sdkUrl,
                timeoutMs: PROVISION_SDK_TIMEOUT_MS,
            });
        } catch (err) {
            throw toClientFacingError(err);
        }
    }

    /**
     * Customer-facing "down": tear down a test user previously provisioned via
     * `provisionForApp`. The caller passes back the `instanceId` / `refs` /
     * `refsToken` from the provision response.
     */
    async teardownForApp(input: TeardownForAppInput): Promise<{ ok: true }> {
        this.logger.info("Tearing down test user", {
            applicationId: input.applicationId,
            environmentId: input.environmentId,
            instanceId: input.instanceId,
        });
        await this.assertEnvironmentBelongsToApp(input.environmentId, input.applicationId, input.organizationId);
        const sdkUrl = await this.resolveSdkUrl(input.environmentId);
        try {
            return await this.down({
                environmentId: input.environmentId,
                scenarioId: input.scenarioId,
                sdkUrl,
                instanceId: input.instanceId,
                refs: input.refs,
                refsToken: input.refsToken,
                timeoutMs: PROVISION_SDK_TIMEOUT_MS,
            });
        } catch (err) {
            throw toClientFacingError(err);
        }
    }

    /**
     * Authorize a tenant-scoped call: the preview environment must belong to the
     * caller's organization, and to the application whose page issued the request
     * (same GitHub repository). Throws `NotFoundError` - never leaking another
     * org's environment - when the triple doesn't line up.
     */
    private async assertEnvironmentBelongsToApp(
        environmentId: string,
        applicationId: string,
        organizationId: string,
    ): Promise<void> {
        const [environment, application] = await Promise.all([
            this.db.previewkitEnvironment.findUnique({
                where: { id: environmentId },
                select: { organizationId: true, githubRepositoryId: true },
            }),
            this.db.application.findFirst({
                where: { id: applicationId, organizationId },
                select: { githubRepositoryId: true },
            }),
        ]);

        const orgOwnsEnvironment = environment != null && environment.organizationId === organizationId;
        if (!orgOwnsEnvironment || application == null) {
            throw new NotFoundError("Preview environment not found");
        }

        const repoMismatch =
            environment.githubRepositoryId != null && environment.githubRepositoryId !== application.githubRepositoryId;
        if (repoMismatch) {
            throw new NotFoundError("Preview environment not found");
        }
    }

    /**
     * Derive the SDK URL for a preview environment from its resolved options,
     * surfacing the same `disabledReason` when the environment can't run an up.
     */
    private async resolveSdkUrl(environmentId: string): Promise<string> {
        const options = await this.getOptions(environmentId);
        if (options.suggestedSdkUrl == null) {
            throw new BadRequestError(
                options.disabledReason ?? "This preview environment cannot provision a test user.",
            );
        }
        return options.suggestedSdkUrl;
    }

    /**
     * Run an Environment Factory "up" against the preview's SDK endpoint and
     * return the seeded credentials / cookies. In-memory only - nothing is
     * persisted.
     */
    async up(input: UpInput): Promise<UpResult> {
        this.logger.info("Running manual env-factory up", {
            environmentId: input.environmentId,
            scenarioId: input.scenarioId,
        });

        const context = await this.resolveContext(input.environmentId, input.scenarioId);

        const fixtureJson = await this.recipeStore.loadRawFixture({ scenarioId: input.scenarioId });
        if (fixtureJson == null) {
            throw new NotFoundError("Scenario has no active recipe");
        }

        const result = await provisionScenarioInstance({
            fixtureJson,
            sdkUrl: input.sdkUrl,
            signingSecret: context.signingSecret,
            customHeaders: context.customHeaders,
            applicationId: context.applicationId,
            sdkOptions: input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : undefined,
        });

        this.logger.info("Manual env-factory up complete", {
            environmentId: input.environmentId,
            scenarioId: input.scenarioId,
            instanceId: result.instanceId,
        });

        return {
            instanceId: result.instanceId,
            auth: result.auth,
            refs: result.refs,
            refsToken: result.refsToken,
            resolvedVariables: result.resolvedVariables,
        };
    }

    /**
     * Tear down a previously provisioned instance. The caller passes back the
     * `instanceId` / `refs` / `refsToken` it got from `up`.
     */
    async down(input: DownInput): Promise<{ ok: true }> {
        this.logger.info("Running manual env-factory down", {
            environmentId: input.environmentId,
            scenarioId: input.scenarioId,
            instanceId: input.instanceId,
        });

        const context = await this.resolveContext(input.environmentId, input.scenarioId);

        await teardownScenarioInstance({
            instanceId: input.instanceId,
            sdkUrl: input.sdkUrl,
            signingSecret: context.signingSecret,
            customHeaders: context.customHeaders,
            refs: input.refs,
            refsToken: input.refsToken,
            applicationId: context.applicationId,
            sdkOptions: input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : undefined,
        });

        this.logger.info("Manual env-factory down complete", {
            environmentId: input.environmentId,
            instanceId: input.instanceId,
        });

        return { ok: true };
    }

    private async resolveContext(environmentId: string, scenarioId: string): Promise<ResolvedContext> {
        const environment = await this.db.previewkitEnvironment.findUnique({
            where: { id: environmentId },
            select: {
                organizationId: true,
                githubRepositoryId: true,
                bypassToken: true,
                branch: { select: { deployment: { select: { webhookHeaders: true } } } },
            },
        });
        if (environment == null) {
            throw new NotFoundError("Preview environment not found");
        }
        if (environment.githubRepositoryId == null) {
            throw new NotFoundError("Environment is not linked to a GitHub repository");
        }

        const application = await this.db.application.findFirst({
            where: { githubRepositoryId: environment.githubRepositoryId, organizationId: environment.organizationId },
            select: { id: true, signingSecretEnc: true },
        });
        if (application == null) {
            throw new NotFoundError("No application is linked to this repository");
        }
        if (application.signingSecretEnc == null) {
            throw new Error("The linked application has no signing secret configured");
        }

        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, applicationId: application.id },
            select: { id: true },
        });
        if (scenario == null) {
            throw new NotFoundError("Scenario does not belong to the linked application");
        }

        const signingSecret = this.encryption.decrypt(application.signingSecretEnc);
        const customHeaders = buildSdkRequestHeaders(
            environment.bypassToken,
            environment.branch?.deployment?.webhookHeaders,
        );

        return { applicationId: application.id, signingSecret, customHeaders };
    }
}

/**
 * Headers for a preview SDK request: the deploy's configured webhook headers
 * (the customer's SDK auth, persisted per branch) plus the Gatekeeper bypass
 * header (`x-previewkit-bypass`, decrypted from the env's token with
 * `PREVIEWKIT_BYPASS_TOKEN_KEY`). The bypass is applied last so it can never be
 * shadowed by a configured header. Returns undefined when neither is present.
 */
function buildSdkRequestHeaders(
    bypassToken: string | null,
    webhookHeaders: Prisma.JsonValue | null | undefined,
): Record<string, string> | undefined {
    const headers = parseStringRecord(webhookHeaders ?? null);
    if (bypassToken != null) {
        headers["x-previewkit-bypass"] = resolvePreviewkitBypassToken(bypassToken, env.PREVIEWKIT_BYPASS_TOKEN_KEY);
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Keep an SDK-call failure's message intact for the tenant. `APIError`s already
 * map to a client code with their message preserved, so they pass through; a
 * plain `Error` (e.g. the SDK timeout) or `SdkHttpError` would otherwise be
 * masked as a 500, so it is re-wrapped as a `BadRequestError` - which is how the
 * "timed out after 180s" text reaches the Test user card.
 */
function toClientFacingError(err: unknown): Error {
    if (err instanceof APIError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new BadRequestError(message);
}
