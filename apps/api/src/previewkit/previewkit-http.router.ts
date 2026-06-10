import { type AuthCaller, type CallerAuthVariables, requireApiKeyOrService } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { type BuildLogEntry, BuildLogSpool } from "@autonoma/logger/build-log-spool";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { auth, redisClient } from "../context";
import { env } from "../env";
import { openApiSpec } from "./openapi-spec";
import previewSchema from "./preview-schema.json" with { type: "json" };
import { PreviewkitEnvironmentsService } from "./previewkit-environments.service";
import { PreviewkitSecretsService, type SecretItem } from "./previewkit-secrets.service";
import { previewkitClient, previewkitTriggerService } from "./previewkit-service";

const logger = rootLogger.child({ name: "previewkitHttpRouter" });

// Native services - these run in the API process (DB + AWS Secrets Manager only,
// no Kubernetes), so they need no forwarding.
const secretsService = new PreviewkitSecretsService(env.S3_REGION);
const environmentsService = new PreviewkitEnvironmentsService(db);

// Live build-log relay. Reads the per-namespace Redis Stream the Previewkit
// build pipeline publishes to and forwards entries over SSE. Reads are
// non-blocking, so the one shared connection serves all concurrent viewers.
const logStreamSpool = new BuildLogSpool(redisClient);
const LOG_STREAM_POLL_MS = 1000;
// Heartbeat (and DB status re-check) cadence while idle, in poll ticks.
const LOG_STREAM_HEARTBEAT_TICKS = 15;
const TERMINAL_STATUSES = new Set(["ready", "failed", "torn_down"]);

// Auth for the native routes. Previewkit is the auth authority for the forwarded
// (heavy) routes, but the native routes terminate here, so the API must
// authenticate them itself - same middleware Previewkit used, applying per-caller
// org-scoping (API-key callers -> their org; the service secret -> no narrowing).
const requireAuth = requireApiKeyOrService({ db, serviceSecret: env.PREVIEWKIT_SERVICE_SECRET });

/**
 * Auth for the browser-facing build-log stream: accept a logged-in app session
 * cookie first (so the SPA can stream without shipping an API key), then fall
 * back to `requireApiKeyOrService` for programmatic / service callers. A session
 * caller is recorded as a `user` AuthCaller so the same org-scoping applies.
 */
const requireStreamAuth: MiddlewareHandler<{ Variables: CallerAuthVariables }> = async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const organizationId = session?.session?.activeOrganizationId;
    if (session?.user != null && organizationId != null) {
        c.set("authCaller", { kind: "user", userId: session.user.id, organizationId });
        return next();
    }
    return requireAuth(c, next);
};

/** Request body for `POST /environments` - mirrors Previewkit's deploy schema. */
const deployRequestSchema = z.object({
    repoFullName: z.string().regex(/^[^/]+\/[^/]+$/, "must be 'owner/repo'"),
    prNumber: z.number().int().positive(),
    organizationId: z.string().min(1),
    githubRepositoryId: z.number().int().positive(),
    headSha: z.string().min(1),
    headRef: z.string().min(1),
    cloneUrl: z.url(),
    baseSha: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
});

/**
 * Public HTTP surface for Previewkit, mounted at `/v1/previewkit`. Two kinds of route:
 *
 *  - **Native** (secrets CRUD, environment status, the `.preview.yaml` JSON schema, and the
 *    `openapi.json` describing this surface): implemented directly here - no forwarding. They
 *    need only the DB + AWS Secrets Manager, which the API already has.
 *
 *  - **Lifecycle ops** (deploy / main-branch deploy / teardown / redeploy): with
 *    `PREVIEWKIT_USE_TEMPORAL` on, the API authenticates the caller, runs the preflight
 *    checks, and starts the Temporal workflow directly (`PreviewkitTriggerService`) - the
 *    Previewkit worker executes the pipeline. With the flag off (legacy), the request is
 *    transparently proxied to Previewkit's HTTP server via `PreviewkitClient` with the
 *    caller's `Authorization` header passed through, and the deploy responses' `statusUrl`
 *    rewritten to this `/v1/previewkit` mount.
 */
export const previewkitHttpRouter = new Hono<{ Variables: CallerAuthVariables }>()
    // ─── Native: environment status (DB-backed) ───────────────────────
    .get("/environments/:owner/:repo/:pr", requireAuth, async (c) => {
        const pr = parseEnvironmentNumber(c.req.param("pr"));
        if (pr == null) return c.json({ error: "pr must be a non-negative integer" }, 400);

        const repoFullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const status = await environmentsService.getStatus(repoFullName, pr, callerOrgId(c.var.authCaller));
        if (status == null) return c.json({ error: "Environment not found" }, 404);
        return c.json(status);
    })

    // ─── Native: live build-log stream (SSE, Redis Stream backed) ─────
    .get("/environments/:owner/:repo/:pr/logs/stream", requireStreamAuth, async (c) => {
        const pr = parseEnvironmentNumber(c.req.param("pr"));
        if (pr == null) return c.json({ error: "pr must be a non-negative integer" }, 400);

        const repoFullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const orgId = callerOrgId(c.var.authCaller);
        const target = await environmentsService.resolveStreamTarget(repoFullName, pr, orgId);
        if (target == null) return c.json({ error: "Environment not found" }, 404);

        // SSE through nginx/ALB: disable response buffering so entries flush live.
        c.header("X-Accel-Buffering", "no");
        c.header("Cache-Control", "no-cache, no-transform");

        return streamSSE(
            c,
            async (stream) => {
                // Resume from a reconnecting EventSource's cursor; "0" replays
                // the full retained buffer for a fresh viewer.
                const lastEventId = c.req.header("Last-Event-ID");
                let cursor = lastEventId != null && lastEventId !== "" ? lastEventId : "0";
                // A build already finished at connect emits no further entries,
                // so close once its buffered tail has been replayed.
                const startedTerminal = isTerminalStatus(target.status);
                let idleTicks = 0;

                const readBatch = async (after: string): Promise<BuildLogEntry[] | undefined> => {
                    try {
                        return await logStreamSpool.readBatch(target.namespace, after);
                    } catch (err) {
                        logger.error("Failed reading build log stream", err, { namespace: target.namespace });
                        return undefined;
                    }
                };

                while (!stream.aborted) {
                    const batch = await readBatch(cursor);
                    if (batch == null) {
                        await stream.writeSSE({ event: "error", data: "stream temporarily unavailable" });
                        return;
                    }

                    if (batch.length > 0) {
                        idleTicks = 0;
                        for (const entry of batch) {
                            await stream.writeSSE({
                                id: entry.id,
                                event: entry.event.kind,
                                data: JSON.stringify(entry.event),
                            });
                            cursor = entry.id;
                            if (entry.event.kind === "status" && isTerminalStatus(entry.event.message)) {
                                await stream.writeSSE({ event: "done", data: entry.event.message });
                                return;
                            }
                        }
                        await stream.sleep(LOG_STREAM_POLL_MS);
                        continue;
                    }

                    if (startedTerminal) {
                        await stream.writeSSE({ event: "done", data: target.status });
                        return;
                    }

                    // Idle: heartbeat + re-check DB status periodically so a build
                    // that ended without a terminal event still closes the stream.
                    idleTicks++;
                    if (idleTicks % LOG_STREAM_HEARTBEAT_TICKS === 0) {
                        await stream.writeSSE({ event: "heartbeat", data: "" });
                        const fresh = await environmentsService.resolveStreamTarget(repoFullName, pr, orgId);
                        if (fresh != null && isTerminalStatus(fresh.status)) {
                            await stream.writeSSE({ event: "done", data: fresh.status });
                            return;
                        }
                    }
                    await stream.sleep(LOG_STREAM_POLL_MS);
                }
            },
            async (err) => {
                // Fires on write-after-disconnect and other stream errors; the
                // client is gone, so a debug breadcrumb is enough.
                logger.debug("Build log SSE stream closed with error", { repoFullName, pr, err });
            },
        );
    })

    // ─── Native: per-app secrets CRUD ─────────────────────────────────
    .get("/secrets/:applicationId/:app", requireAuth, async (c) => {
        const applicationId = c.req.param("applicationId");
        const app = c.req.param("app");
        const keys = await secretsService.list(applicationId, app, callerOrgId(c.var.authCaller));
        return c.json({ applicationId, app, keys });
    })
    .put("/secrets/:applicationId/:app", requireAuth, async (c) => {
        const applicationId = c.req.param("applicationId");
        const app = c.req.param("app");

        let body: { items?: unknown };
        try {
            body = await c.req.json<{ items?: unknown }>();
        } catch {
            return c.json({ error: "Body must be JSON" }, 400);
        }

        const validation = validateItems(body.items);
        if (!validation.ok) return c.json({ error: validation.error }, 400);

        try {
            await secretsService.upsert(applicationId, app, validation.items, callerOrgId(c.var.authCaller));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("Application not found")) return c.json({ error: message }, 404);
            throw err;
        }

        return c.json({ applicationId, app, status: "saved", count: validation.items.length });
    })
    .put("/secrets/:applicationId/:app/:key", requireAuth, async (c) => {
        const applicationId = c.req.param("applicationId");
        const app = c.req.param("app");
        const key = c.req.param("key");

        let body: { value?: unknown };
        try {
            body = await c.req.json<{ value?: unknown }>();
        } catch {
            return c.json({ error: "Body must be JSON" }, 400);
        }

        if (typeof body.value !== "string" || body.value.length === 0) {
            return c.json({ error: "Request body must include a non-empty string 'value'" }, 400);
        }

        try {
            await secretsService.upsert(
                applicationId,
                app,
                [{ key, value: body.value }],
                callerOrgId(c.var.authCaller),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("Application not found")) return c.json({ error: message }, 404);
            throw err;
        }

        return c.json({ applicationId, app, key, status: "saved" });
    })
    .delete("/secrets/:applicationId/:app/:key", requireAuth, async (c) => {
        const applicationId = c.req.param("applicationId");
        const app = c.req.param("app");
        const key = c.req.param("key");

        const deleted = await secretsService.delete(applicationId, app, key, callerOrgId(c.var.authCaller));
        if (!deleted) return c.json({ error: `Secret '${key}' not found` }, 404);

        return c.json({ applicationId, app, key, status: "deleted" });
    })

    // ─── Native: static `.preview.yaml` JSON schema (public, for editors) ──
    .get("/schema/preview.yaml.json", (c) => c.json(previewSchema))

    // ─── Lifecycle ops: native Temporal triggers, or proxied to Previewkit (legacy) ───
    .post("/environments", requireAuth, async (c) => {
        if (!env.PREVIEWKIT_USE_TEMPORAL) return proxyToPreviewkit(c, "environments", rewriteDeployStatusUrl);

        const body = await c.req.json().catch(() => undefined);
        const parsed = deployRequestSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);

        const orgId = callerOrgId(c.var.authCaller);
        if (orgId != null && orgId !== parsed.data.organizationId) {
            return c.json({ error: "organizationId does not match the caller's organization" }, 403);
        }

        const { repoFullName, prNumber } = parsed.data;
        try {
            await previewkitTriggerService.deploy(parsed.data);
        } catch (error) {
            return lifecycleErrorResponse(c, error, { repoFullName, prNumber });
        }

        return c.json(
            {
                accepted: true,
                repoFullName,
                prNumber,
                statusUrl: `/v1/previewkit/environments/${repoFullName}/${prNumber}`,
            },
            202,
        );
    })
    .post("/applications/:applicationId/0", requireAuth, async (c) => {
        if (!env.PREVIEWKIT_USE_TEMPORAL) {
            return proxyToPreviewkit(c, `applications/${c.req.param("applicationId")}/0`, rewriteDeployStatusUrl);
        }

        const applicationId = c.req.param("applicationId");
        try {
            const result = await previewkitTriggerService.deployMainBranch(
                applicationId,
                callerOrgId(c.var.authCaller),
            );
            return c.json(
                {
                    accepted: true,
                    applicationId: result.applicationId,
                    repoFullName: result.repoFullName,
                    branch: result.branch,
                    headSha: result.headSha,
                    prNumber: result.prNumber,
                    statusUrl: `/v1/previewkit/environments/${result.repoFullName}/${result.prNumber}`,
                },
                202,
            );
        } catch (error) {
            return lifecycleErrorResponse(c, error, { applicationId });
        }
    })
    .delete("/environments/:owner/:repo/:pr", requireAuth, async (c) => {
        if (!env.PREVIEWKIT_USE_TEMPORAL) return proxyToPreviewkit(c, environmentSubPath(c));

        const pr = parseEnvironmentNumber(c.req.param("pr"));
        if (pr == null) return c.json({ error: "pr must be a non-negative integer" }, 400);

        const organizationId = c.req.query("organizationId");
        if (organizationId == null || organizationId === "") {
            return c.json({ error: "organizationId query param is required" }, 400);
        }
        const githubRepositoryIdRaw = c.req.query("githubRepositoryId");
        const githubRepositoryId = githubRepositoryIdRaw != null ? Number(githubRepositoryIdRaw) : NaN;
        if (!Number.isInteger(githubRepositoryId) || githubRepositoryId <= 0) {
            return c.json({ error: "githubRepositoryId query param must be a positive integer" }, 400);
        }

        const orgId = callerOrgId(c.var.authCaller);
        if (orgId != null && orgId !== organizationId) {
            return c.json({ error: "organizationId does not match the caller's organization" }, 403);
        }

        const repoFullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
        try {
            await previewkitTriggerService.teardown({ repoFullName, prNumber: pr, organizationId, githubRepositoryId });
        } catch (error) {
            return lifecycleErrorResponse(c, error, { repoFullName, prNumber: pr });
        }

        return c.json({ accepted: true, repoFullName, prNumber: pr }, 202);
    })
    .post("/environments/:owner/:repo/:pr/redeploy", requireAuth, async (c) => {
        if (!env.PREVIEWKIT_USE_TEMPORAL) return proxyToPreviewkit(c, `${environmentSubPath(c)}/redeploy`);

        const pr = parseEnvironmentNumber(c.req.param("pr"));
        if (pr == null) return c.json({ error: "pr must be a non-negative integer" }, 400);

        const repoFullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
        try {
            await previewkitTriggerService.redeploy(repoFullName, pr, callerOrgId(c.var.authCaller));
        } catch (error) {
            return lifecycleErrorResponse(c, error, { repoFullName, prNumber: pr });
        }

        return c.json({ accepted: true, repoFullName, prNumber: pr }, 202);
    })
    .get("/openapi.json", (c) => c.json(openApiSpec));

function callerOrgId(caller: AuthCaller): string | undefined {
    return caller.kind === "user" ? caller.organizationId : undefined;
}

/** Maps trigger-service errors to the same statuses Previewkit's own routes used. */
function lifecycleErrorResponse(c: Context, error: unknown, logContext: Record<string, string | number>): Response {
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ConflictError) return c.json({ error: error.message }, 409);

    logger.error("Preview lifecycle operation failed", error, logContext);
    return c.json({ error: "Preview lifecycle operation failed" }, 500);
}

/** A finished environment emits no further log entries, so the SSE relay closes. */
function isTerminalStatus(status: string): boolean {
    return TERMINAL_STATUSES.has(status);
}

function parseEnvironmentNumber(raw: string): number | undefined {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return undefined;
    return value;
}

function environmentSubPath(c: Context): string {
    return `environments/${c.req.param("owner")}/${c.req.param("repo")}/${c.req.param("pr")}`;
}

interface ValidatedItems {
    ok: true;
    items: SecretItem[];
}
interface InvalidItems {
    ok: false;
    error: string;
}

function validateItems(raw: unknown): ValidatedItems | InvalidItems {
    if (!Array.isArray(raw)) {
        return { ok: false, error: "Body must include an 'items' array" };
    }
    if (raw.length === 0) {
        return { ok: false, error: "'items' must contain at least one entry" };
    }

    const items: SecretItem[] = [];
    for (let i = 0; i < raw.length; i++) {
        const entry: unknown = raw[i];
        if (typeof entry !== "object" || entry == null) {
            return { ok: false, error: `items[${i}] must be an object with 'key' and 'value'` };
        }
        const key = "key" in entry ? entry.key : undefined;
        const value = "value" in entry ? entry.value : undefined;
        if (typeof key !== "string" || key.length === 0) {
            return { ok: false, error: `items[${i}].key must be a non-empty string` };
        }
        if (typeof value !== "string" || value.length === 0) {
            return { ok: false, error: `items[${i}].value must be a non-empty string` };
        }
        items.push({ key, value });
    }
    return { ok: true, items };
}

/**
 * Transparently forward a request to Previewkit, returning its response verbatim.
 * `rewriteBody` optionally post-processes the response body - used to rewrite the
 * `statusUrl` in deploy responses to the API's `/v1/previewkit` mount.
 */
async function proxyToPreviewkit(
    c: Context,
    subPath: string,
    rewriteBody?: (body: string) => string,
): Promise<Response> {
    if (!previewkitClient.hasBaseUrl()) {
        return c.json({ error: "Preview environments are not configured." }, 503);
    }

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "DELETE" && method !== "HEAD";

    let body: ArrayBuffer | undefined;
    if (hasBody) {
        const raw = await c.req.arrayBuffer();
        body = raw.byteLength > 0 ? raw : undefined;
    }

    const search = new URL(c.req.url).search;

    try {
        const result = await previewkitClient.forward({
            method,
            subPath,
            authorization: c.req.header("authorization"),
            contentType: c.req.header("content-type"),
            searchParams: search.startsWith("?") ? search.slice(1) : search,
            body,
        });
        const outBody = rewriteBody != null ? rewriteBody(result.body) : result.body;
        return new Response(outBody, {
            status: result.status,
            headers: { "content-type": result.contentType },
        });
    } catch (err) {
        logger.error("Failed to proxy request to Previewkit", err, { method, subPath });
        return c.json({ error: "Failed to reach Previewkit." }, 502);
    }
}

/**
 * Rewrite the `statusUrl` in a Previewkit deploy response from Previewkit's own
 * `/v1/...` path to the API's public `/v1/previewkit/...` mount, so callers of the
 * autonoma API follow a URL that actually exists here. Returns the body unchanged
 * if it isn't JSON or has no `statusUrl`.
 */
function rewriteDeployStatusUrl(body: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return body;
    }
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return body;

    const statusUrl = "statusUrl" in parsed ? parsed.statusUrl : undefined;
    if (typeof statusUrl !== "string" || !statusUrl.startsWith("/v1/")) return body;

    return JSON.stringify({ ...parsed, statusUrl: statusUrl.replace(/^\/v1\//, "/v1/previewkit/") });
}
