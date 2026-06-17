import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
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
import { parseManifest, parseStringRecord, resolvePrimaryUrl } from "./preview-summary";

export interface EnvFactoryOptions {
    applicationId: string | undefined;
    applicationName: string | undefined;
    scenarios: Array<{ id: string; name: string }>;
    appUrls: Array<{ appName: string; url: string }>;
    suggestedSdkUrl: string | undefined;
    /** Set when the environment cannot run a manual up (and why). */
    disabledReason: string | undefined;
}

interface UpInput {
    environmentId: string;
    scenarioId: string;
    sdkUrl: string;
}

interface DownInput {
    environmentId: string;
    scenarioId: string;
    sdkUrl: string;
    instanceId: string;
    refs?: Refs;
    refsToken?: string;
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
     * app URLs, and a suggested SDK URL (the preview's primary URL combined with
     * the path from the Application's main-branch webhook). Returns a
     * `disabledReason` instead of throwing when a manual up cannot be run.
     */
    async getOptions(environmentId: string): Promise<EnvFactoryOptions> {
        this.logger.info("Resolving previewkit env-factory options", { environmentId });

        const environment = await this.db.previewkitEnvironment.findUnique({
            where: { id: environmentId },
            select: { id: true, organizationId: true, githubRepositoryId: true, urls: true, manifest: true },
        });
        if (environment == null) {
            throw new NotFoundError("Preview environment not found");
        }

        const urls = parseStringRecord(environment.urls);
        const manifest = parseManifest(environment.manifest);
        const primaryUrl = resolvePrimaryUrl(manifest, urls);
        const appUrls = Object.entries(urls).map(([appName, url]) => ({ appName, url }));

        const disabled = (disabledReason: string): EnvFactoryOptions => ({
            applicationId: undefined,
            applicationName: undefined,
            scenarios: [],
            appUrls,
            suggestedSdkUrl: undefined,
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

        const suggestedSdkUrl = derivePreviewSdkUrl(primaryUrl, application.mainBranch?.deployment?.webhookUrl);
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
            disabledReason: undefined,
        };
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
            select: { organizationId: true, githubRepositoryId: true, bypassToken: true },
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
        const customHeaders = buildBypassHeaders(environment.bypassToken);

        return { applicationId: application.id, signingSecret, customHeaders };
    }
}

/**
 * Build the Gatekeeper bypass header for a preview request. Gatekeeper gates
 * each preview behind the bypass token (`x-previewkit-bypass`), stored encrypted
 * with `PREVIEWKIT_BYPASS_TOKEN_KEY`. Returns undefined when no token exists.
 */
function buildBypassHeaders(bypassToken: string | null): Record<string, string> | undefined {
    if (bypassToken == null) return undefined;
    return { "x-previewkit-bypass": resolvePreviewkitBypassToken(bypassToken, env.PREVIEWKIT_BYPASS_TOKEN_KEY) };
}
