import { randomUUID } from "node:crypto";
import { logger } from "@autonoma/logger";
import type { AuthPayload, ScenarioRecipe, ScenarioVariableScalar } from "@autonoma/types";
import { resolveRecipePayload } from "./scenario-recipe-resolver";
import { NOOP_RECORDER } from "./sdk-call-recorder";
import { SdkClient, type SdkCallOptions } from "./sdk-client";

export interface ProvisionConfig {
    /** Raw unresolved recipe for the scenario (from `ScenarioRecipeStore.loadRawFixture`). */
    fixtureJson: ScenarioRecipe;
    /** Stable identifier for this provisioning run. Generated automatically when omitted. */
    testRunId?: string;
    sdkUrl: string;
    /** Plain (already decrypted) signing secret for the SDK endpoint. */
    signingSecret: string;
    customHeaders?: Record<string, string>;
    /** Used only for log context. Defaults to "eval". */
    applicationId?: string;
    sdkOptions?: SdkCallOptions;
}

export interface ProvisionedInstance {
    instanceId: string;
    auth: AuthPayload | undefined;
    refs: Record<string, unknown> | undefined;
    refsToken: string | undefined;
    resolvedVariables: Record<string, ScenarioVariableScalar>;
    /**
     * The resolved entity-create payload sent to the SDK's `up` call. Mirrors
     * what production persists as `ScenarioInstance.generatedData`, so callers
     * without a DB (evals, local tooling) can materialise scenario-data grounding
     * context from the in-memory result of provisioning alone.
     */
    createPayload: Record<string, unknown>;
}

export interface TeardownConfig {
    instanceId: string;
    sdkUrl: string;
    /** Plain (already decrypted) signing secret for the SDK endpoint. */
    signingSecret: string;
    customHeaders?: Record<string, string>;
    refs?: Record<string, unknown>;
    refsToken?: string;
    /** Used only for log context. Defaults to "eval". */
    applicationId?: string;
    sdkOptions?: SdkCallOptions;
}

const provisionLogger = logger.child({ name: "provisionScenarioInstance" });
const teardownLogger = logger.child({ name: "teardownScenarioInstance" });

/**
 * Stand up a fresh scenario instance against the customer's live SDK endpoint
 * without touching the database.
 *
 * Composes:
 *   resolveRecipePayload(fixtureJson, testRunId)
 *   -> SdkClient.up({ instanceId, create }) with NOOP_RECORDER
 *   -> returns { instanceId, auth, refs, refsToken, resolvedVariables }
 *
 * Each call generates a fresh testRunId (unless supplied), which drives
 * variable resolution and produces unique auth + data per invocation.
 *
 * Pair with `teardownScenarioInstance` to clean up after the eval or test.
 */
export async function provisionScenarioInstance(config: ProvisionConfig): Promise<ProvisionedInstance> {
    const { fixtureJson, sdkUrl, signingSecret, customHeaders, sdkOptions, applicationId = "eval" } = config;
    const instanceId = config.testRunId ?? randomUUID();

    provisionLogger.info("Provisioning scenario instance", { applicationId, instanceId });

    const { createPayload, resolvedVariables } = resolveRecipePayload(fixtureJson, instanceId);

    const client = new SdkClient({
        applicationId,
        sdkUrl,
        signingSecret,
        customHeaders,
        recorder: NOOP_RECORDER,
    });

    const response = await client.up({ instanceId, create: createPayload }, sdkOptions);

    provisionLogger.info("Scenario instance provisioned", { applicationId, instanceId });

    return {
        instanceId,
        auth: response.auth,
        refs: response.refs,
        refsToken: response.refsToken,
        resolvedVariables,
        createPayload,
    };
}

/**
 * Tear down a previously provisioned scenario instance.
 *
 * Mirrors `provisionScenarioInstance`: pure SDK call, no database writes.
 * Throws on SDK error so the caller can handle or surface the failure.
 */
export async function teardownScenarioInstance(config: TeardownConfig): Promise<void> {
    const { instanceId, sdkUrl, signingSecret, customHeaders, refsToken, sdkOptions, applicationId = "eval" } = config;

    teardownLogger.info("Tearing down scenario instance", { applicationId, instanceId });

    const client = new SdkClient({
        applicationId,
        sdkUrl,
        signingSecret,
        customHeaders,
        recorder: NOOP_RECORDER,
    });

    await client.down(
        {
            instanceId,
            refs: config.refs ?? null,
            refsToken,
        },
        sdkOptions,
    );

    teardownLogger.info("Scenario instance torn down", { applicationId, instanceId });
}
