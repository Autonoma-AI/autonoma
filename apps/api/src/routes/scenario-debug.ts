/**
 * Shared builder for the admin-only "debug" payload exposed by run and
 * generation detail endpoints. Callers must gate access on `isAdmin` before
 * invoking this - the helper assumes the caller is authorized.
 */

interface ScenarioInstanceInput {
    id: string;
    status: string;
    upAt: Date | null;
    downAt: Date | null;
    lastError: unknown;
    auth: unknown;
    resolvedVariables: unknown;
    scenario: { name: string };
    deployment: {
        webhookUrl: string | null;
        webDeployment: { url: string } | null;
    } | null;
}

interface SnapshotInput {
    id: string;
    status: string;
    branch: { name: string };
}

interface WebhookCallInput {
    id: string;
    action: string;
    statusCode: number | null;
    durationMs: number | null;
    error: string | null;
    createdAt: Date;
    requestBody: unknown;
    responseBody: unknown;
}

interface ScenarioAuth {
    cookies?: Array<{ name: string }>;
    headers?: Record<string, string>;
}

function toAuthSummary(auth: unknown) {
    if (auth == null || typeof auth !== "object") return undefined;
    const typed = auth as ScenarioAuth;
    return {
        cookieNames: typed.cookies?.map((c) => c.name) ?? [],
        headerKeys: Object.keys(typed.headers ?? {}),
    };
}

function toLastError(value: unknown): { message: string } | undefined {
    if (value == null || typeof value !== "object") return undefined;
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? { message } : undefined;
}

function toDeploymentUrl(instance: ScenarioInstanceInput | null): string | undefined {
    if (instance?.deployment == null) return undefined;
    return instance.deployment.webDeployment?.url ?? instance.deployment.webhookUrl ?? undefined;
}

export interface ScenarioDebugPayload {
    scenarioInstance?: {
        id: string;
        status: string;
        upAt?: string;
        downAt?: string;
        lastError?: { message: string };
        auth?: { cookieNames: string[]; headerKeys: string[] };
        resolvedVariables?: Record<string, unknown>;
    };
    deploymentUrl?: string;
    scenarioName?: string;
    snapshot?: { id: string; status: string; branchName: string };
    webhookCalls: Array<{
        id: string;
        action: string;
        statusCode?: number;
        durationMs?: number;
        error?: string;
        createdAt: string;
        requestBody: unknown;
        responseBody: unknown;
    }>;
}

export function buildScenarioDebug(args: {
    scenarioInstance: ScenarioInstanceInput | null;
    snapshot: SnapshotInput | null;
    webhookCalls: WebhookCallInput[];
    scenarioName: string | null | undefined;
}): ScenarioDebugPayload {
    const { scenarioInstance, snapshot, webhookCalls, scenarioName } = args;

    return {
        scenarioInstance:
            scenarioInstance != null
                ? {
                      id: scenarioInstance.id,
                      status: scenarioInstance.status,
                      upAt: scenarioInstance.upAt?.toISOString(),
                      downAt: scenarioInstance.downAt?.toISOString(),
                      lastError: toLastError(scenarioInstance.lastError),
                      auth: toAuthSummary(scenarioInstance.auth),
                      resolvedVariables:
                          scenarioInstance.resolvedVariables != null &&
                          typeof scenarioInstance.resolvedVariables === "object"
                              ? (scenarioInstance.resolvedVariables as Record<string, unknown>)
                              : undefined,
                  }
                : undefined,
        deploymentUrl: toDeploymentUrl(scenarioInstance),
        scenarioName: scenarioName ?? scenarioInstance?.scenario.name ?? undefined,
        snapshot:
            snapshot != null
                ? { id: snapshot.id, status: snapshot.status, branchName: snapshot.branch.name }
                : undefined,
        webhookCalls: webhookCalls.map((call) => ({
            id: call.id,
            action: call.action,
            statusCode: call.statusCode ?? undefined,
            durationMs: call.durationMs ?? undefined,
            error: call.error ?? undefined,
            createdAt: call.createdAt.toISOString(),
            requestBody: call.requestBody,
            responseBody: call.responseBody,
        })),
    };
}
