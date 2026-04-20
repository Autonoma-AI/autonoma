import { Hono } from "hono";
import type { SecretStore } from "../secrets/secret-store";

export function createSecretsRoute(secretStore: SecretStore) {
    return new Hono()
        .get("/secrets/:owner/:app", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const keys = await secretStore.list(owner, app);
            return c.json({ owner, app, keys });
        })

        .put("/secrets/:owner/:app/:key", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const key = c.req.param("key");
            const body = await c.req.json<{ value: string }>();

            if (!body.value || typeof body.value !== "string") {
                return c.json({ error: "Request body must include a string 'value'" }, 400);
            }

            await secretStore.set(owner, app, key, body.value);
            return c.json({ owner, app, key, status: "saved" });
        })

        .delete("/secrets/:owner/:app/:key", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const key = c.req.param("key");
            const deleted = await secretStore.delete(owner, app, key);

            if (!deleted) {
                return c.json({ error: `Secret '${key}' not found` }, 404);
            }

            return c.json({ owner, app, key, status: "deleted" });
        })

        .get("/secrets/:owner/:app/pr/:pr", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const pr = parsePr(c.req.param("pr"));
            if (pr == null) return c.json({ error: "pr must be a positive integer" }, 400);

            const keys = await secretStore.list(owner, app, pr);
            return c.json({ owner, app, pr, keys });
        })

        .put("/secrets/:owner/:app/pr/:pr/:key", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const key = c.req.param("key");
            const pr = parsePr(c.req.param("pr"));
            if (pr == null) return c.json({ error: "pr must be a positive integer" }, 400);

            const body = await c.req.json<{ value: string }>();
            if (!body.value || typeof body.value !== "string") {
                return c.json({ error: "Request body must include a string 'value'" }, 400);
            }

            await secretStore.set(owner, app, key, body.value, pr);
            return c.json({ owner, app, pr, key, status: "saved" });
        })

        .delete("/secrets/:owner/:app/pr/:pr/:key", async (c) => {
            const owner = c.req.param("owner");
            const app = c.req.param("app");
            const key = c.req.param("key");
            const pr = parsePr(c.req.param("pr"));
            if (pr == null) return c.json({ error: "pr must be a positive integer" }, 400);

            const deleted = await secretStore.delete(owner, app, key, pr);
            if (!deleted) return c.json({ error: `Secret '${key}' not found` }, 404);

            return c.json({ owner, app, pr, key, status: "deleted" });
        });
}

function parsePr(raw: string): number | undefined {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return undefined;
    return n;
}
