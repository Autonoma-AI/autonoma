export interface ScenarioInstanceDebug {
    id: string;
    status: string;
    upAt?: string;
    downAt?: string;
    lastError?: { message: string };
    auth?: {
        cookieNames: string[];
        headerKeys: string[];
    };
    resolvedVariables?: Record<string, unknown>;
}

export interface SnapshotDebug {
    id: string;
    status: string;
    branchName: string;
}

export interface WebhookCallDebug {
    id: string;
    action: string;
    statusCode?: number;
    durationMs?: number;
    error?: string;
    createdAt: string;
    requestBody: unknown;
    responseBody: unknown;
}

export interface DebugData {
    scenarioInstance?: ScenarioInstanceDebug;
    deploymentUrl?: string;
    scenarioName?: string;
    snapshot?: SnapshotDebug;
    webhookCalls: WebhookCallDebug[];
}
