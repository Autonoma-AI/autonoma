import { type Logger, logger } from "@autonoma/logger";

/** The deploy payload Previewkit's `POST /v1/environments` expects. Mirrors its
 *  `deployRequestSchema`; built by the GitHub webhook forwarder. */
export interface PreviewkitDeployEvent {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
    headSha: string;
    headRef: string;
    baseSha?: string;
    baseRef?: string;
    cloneUrl: string;
}

export interface PreviewkitTeardownParams {
    repoFullName: string;
    prNumber: number;
    organizationId: string;
    githubRepositoryId: number;
}

/** A request to transparently forward to Previewkit, preserving the caller's
 *  own `Authorization` header (so Previewkit's auth + org-scoping still apply). */
export interface PreviewkitForwardRequest {
    method: string;
    /** Path under Previewkit's `/v1` (no leading slash), e.g. `secrets/app_x/web`. */
    subPath: string;
    /** The caller's original Authorization header, passed through verbatim. */
    authorization: string | undefined;
    contentType: string | undefined;
    /** Query string without the leading `?` (empty when none). */
    searchParams: string;
    body: ArrayBuffer | undefined;
}

export interface PreviewkitForwardResponse {
    status: number;
    body: string;
    contentType: string;
}

/**
 * Owns all HTTP communication between the autonoma API and the Previewkit
 * service. Two distinct modes:
 *
 *  - `forward()` - transparent proxy for the public `/v1/previewkit/*` routes.
 *    It passes the *caller's* Authorization header through unchanged, so
 *    Previewkit's `requireApiKeyOrService` remains the auth authority and keeps
 *    applying per-caller org-scoping. Never substitute the service secret here.
 *
 *  - `deploy()` / `teardown()` / `redeploy()` - typed service-to-service calls
 *    used by internal callers (GitHub webhook forwarder, admin redeploy). These
 *    authenticate with the shared service secret and reproduce the exact
 *    semantics those callers had when they fetched Previewkit inline.
 */
export class PreviewkitClient {
    private readonly logger: Logger;
    private readonly baseUrl: string | undefined;

    constructor(
        baseUrl: string | undefined,
        private readonly serviceSecret: string | undefined,
    ) {
        // Strip a trailing slash so `${baseUrl}/v1/...` never doubles up.
        this.baseUrl = baseUrl != null ? baseUrl.replace(/\/$/, "") : undefined;
        this.logger = logger.child({ name: this.constructor.name });
    }

    /** Both the base URL and the shared secret are present. */
    isConfigured(): boolean {
        return this.baseUrl != null && this.serviceSecret != null;
    }

    /** Whether a Previewkit base URL is configured at all (preview environments enabled). */
    hasBaseUrl(): boolean {
        return this.baseUrl != null;
    }

    /**
     * Transparently forward a request to Previewkit, returning its response
     * verbatim (status + body + content-type). The caller's Authorization
     * header is passed through; we do NOT inject the service secret.
     */
    async forward(request: PreviewkitForwardRequest): Promise<PreviewkitForwardResponse> {
        const baseUrl = this.baseUrl;
        if (baseUrl == null) {
            throw new Error("PreviewkitClient.forward called while Previewkit is not configured");
        }

        const query = request.searchParams.length > 0 ? `?${request.searchParams}` : "";
        const url = `${baseUrl}/v1/${request.subPath}${query}`;

        const headers: Record<string, string> = {};
        if (request.authorization != null) headers.authorization = request.authorization;
        if (request.contentType != null) headers["content-type"] = request.contentType;

        const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(15_000) };
        if (request.body != null) init.body = request.body;

        // Never log the body: secret values flow through the secrets routes.
        this.logger.info("Proxying request to Previewkit", { method: request.method, subPath: request.subPath });

        const response = await fetch(url, init);
        const body = await response.text();
        return {
            status: response.status,
            body,
            contentType: response.headers.get("content-type") ?? "application/json",
        };
    }

    /** Deploy a PR preview environment. Service-to-service. */
    async deploy(event: PreviewkitDeployEvent): Promise<void> {
        const response = await this.serviceFetch("POST", "environments", event);
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Previewkit deploy returned ${response.status}: ${text}`);
        }
        this.logger.info("Forwarded PR deploy to Previewkit", {
            repoFullName: event.repoFullName,
            prNumber: event.prNumber,
        });
    }

    /** Tear down a PR preview environment. A 404 is tolerated (already gone). */
    async teardown(params: PreviewkitTeardownParams): Promise<void> {
        const [owner, repo] = params.repoFullName.split("/");
        const query = new URLSearchParams({
            organizationId: params.organizationId,
            githubRepositoryId: String(params.githubRepositoryId),
        });
        const response = await this.serviceFetch(
            "DELETE",
            `environments/${owner}/${repo}/${params.prNumber}?${query.toString()}`,
        );
        if (!response.ok && response.status !== 404) {
            const text = await response.text().catch(() => "");
            throw new Error(`Previewkit teardown returned ${response.status}: ${text}`);
        }
        this.logger.info("Forwarded PR teardown to Previewkit", {
            repoFullName: params.repoFullName,
            prNumber: params.prNumber,
        });
    }

    /** Re-run the pipeline for an existing environment. Surfaces Previewkit's
     *  own error detail (e.g. a torn-down env returns 409) to the caller. */
    async redeploy(repoFullName: string, prNumber: number): Promise<void> {
        const [owner, repo] = repoFullName.split("/");
        const response = await this.serviceFetch("POST", `environments/${owner}/${repo}/${prNumber}/redeploy`);
        if (!response.ok) {
            const payload: unknown = await response.json().catch(() => undefined);
            const detail = extractErrorDetail(payload);
            this.logger.warn("Previewkit redeploy returned non-OK", {
                status: response.status,
                repoFullName,
                prNumber,
            });
            throw new Error(detail ?? `Previewkit redeploy failed with status ${response.status}.`);
        }
        this.logger.info("Triggered previewkit redeploy", { repoFullName, prNumber });
    }

    /** Deploy an Application's main branch into environment 0 (the stable
     *  non-PR environment). Service-to-service. Previewkit resolves the repo and
     *  branch head itself; we surface its own error detail (e.g. a disabled or
     *  unlinked application returns 409). */
    async deployMainBranch(applicationId: string): Promise<void> {
        const response = await this.serviceFetch("POST", `applications/${applicationId}/0`);
        if (!response.ok) {
            const payload: unknown = await response.json().catch(() => undefined);
            const detail = extractErrorDetail(payload);
            this.logger.warn("Previewkit main-branch deploy returned non-OK", {
                status: response.status,
                applicationId,
            });
            throw new Error(detail ?? `Previewkit main-branch deploy failed with status ${response.status}.`);
        }
        this.logger.info("Triggered previewkit main-branch deploy", { applicationId });
    }

    /** Build a service-to-service request authenticated with the shared secret. */
    private async serviceFetch(method: string, subPath: string, jsonBody?: unknown): Promise<Response> {
        const baseUrl = this.baseUrl;
        const serviceSecret = this.serviceSecret;
        if (baseUrl == null || serviceSecret == null) {
            throw new Error("PreviewkitClient service call attempted while Previewkit is not configured");
        }

        const headers: Record<string, string> = { authorization: `Bearer ${serviceSecret}` };
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000) };
        if (jsonBody !== undefined) {
            headers["content-type"] = "application/json";
            init.body = JSON.stringify(jsonBody);
        }

        return fetch(`${baseUrl}/v1/${subPath}`, init);
    }
}

/** Pull the `error` string out of Previewkit's JSON error body, if present. */
function extractErrorDetail(payload: unknown): string | undefined {
    if (typeof payload === "object" && payload != null && "error" in payload && typeof payload.error === "string") {
        return payload.error;
    }
    return undefined;
}
