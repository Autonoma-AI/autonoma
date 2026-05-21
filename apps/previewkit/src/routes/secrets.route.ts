import type { AuthCaller, CallerAuthVariables } from "@autonoma/auth";
import { Hono } from "hono";
import type { PreviewkitSecretsService, SecretItem } from "../secrets/secrets-service";

/** `undefined` for service callers (no org narrowing); the user's
 *  organizationId for API-key callers. */
function callerOrgId(caller: AuthCaller): string | undefined {
    return caller.kind === "user" ? caller.organizationId : undefined;
}

/**
 * HTTP REST routes for managing AWS Secrets Manager bundles. Mirrors the
 * autonoma API's tRPC `secrets.list/upsert/delete` for callers that
 * prefer curl over a typed client (CI, scripts, internal tooling).
 *
 * URL shape: `/v1/secrets/:applicationId/:app[/:key]`. We use the
 * application's CUID rather than (owner, repo) because the latter
 * would require a GitHub API roundtrip to resolve to the numeric repo
 * id Previewkit stores. Look up your applicationId once via the
 * autonoma dashboard and hardcode it in your CI.
 *
 * Authentication: none on the internal network. The previewkit
 * Service should be locked down to internal callers only.
 */
export function createSecretsRoute(service: PreviewkitSecretsService) {
    return new Hono<{ Variables: CallerAuthVariables }>()
        .get("/secrets/:applicationId/:app", async (c) => {
            const applicationId = c.req.param("applicationId");
            const app = c.req.param("app");
            const keys = await service.list(applicationId, app, callerOrgId(c.var.authCaller));
            return c.json({ applicationId, app, keys });
        })

        .put("/secrets/:applicationId/:app", async (c) => {
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
                await service.upsert(applicationId, app, validation.items, callerOrgId(c.var.authCaller));
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes("Application not found")) {
                    return c.json({ error: message }, 404);
                }
                throw err;
            }

            return c.json({ applicationId, app, status: "saved", count: validation.items.length });
        })

        .put("/secrets/:applicationId/:app/:key", async (c) => {
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
                await service.upsert(applicationId, app, [{ key, value: body.value }], callerOrgId(c.var.authCaller));
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes("Application not found")) {
                    return c.json({ error: message }, 404);
                }
                throw err;
            }

            return c.json({ applicationId, app, key, status: "saved" });
        })

        .delete("/secrets/:applicationId/:app/:key", async (c) => {
            const applicationId = c.req.param("applicationId");
            const app = c.req.param("app");
            const key = c.req.param("key");

            const deleted = await service.delete(applicationId, app, key, callerOrgId(c.var.authCaller));
            if (!deleted) return c.json({ error: `Secret '${key}' not found` }, 404);

            return c.json({ applicationId, app, key, status: "deleted" });
        });
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
        const entry = raw[i];
        if (typeof entry !== "object" || entry == null) {
            return { ok: false, error: `items[${i}] must be an object with 'key' and 'value'` };
        }
        const e = entry as { key?: unknown; value?: unknown };
        if (typeof e.key !== "string" || e.key.length === 0) {
            return { ok: false, error: `items[${i}].key must be a non-empty string` };
        }
        if (typeof e.value !== "string" || e.value.length === 0) {
            return { ok: false, error: `items[${i}].value must be a non-empty string` };
        }
        items.push({ key: e.key, value: e.value });
    }
    return { ok: true, items };
}
