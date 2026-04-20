import * as k8s from "@kubernetes/client-node";
import { Hono } from "hono";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSecretsRoute } from "../../src/routes/secrets.route.js";
import { SecretStore } from "../../src/secrets/secret-store.js";

function createMockKubeConfig() {
    const secrets = new Map<string, k8s.V1Secret>();

    const mockApi = {
        readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
            const secret = secrets.get(name);
            if (!secret) throw new k8s.ApiException(404, "Not Found", {}, {});
            return secret;
        }),
        createNamespacedSecret: vi.fn(async ({ body }: { namespace: string; body: k8s.V1Secret }) => {
            const name = body.metadata!.name!;
            if (secrets.has(name)) throw new k8s.ApiException(409, "Conflict", {}, {});
            secrets.set(name, structuredClone(body));
            return body;
        }),
        replaceNamespacedSecret: vi.fn(
            async ({ name, body }: { name: string; namespace: string; body: k8s.V1Secret }) => {
                secrets.set(name, structuredClone(body));
                return body;
            },
        ),
    };

    return {
        kc: { makeApiClient: vi.fn(() => mockApi) } as unknown as k8s.KubeConfig,
    };
}

let app: Hono;

beforeEach(() => {
    const { kc } = createMockKubeConfig();
    const store = new SecretStore(kc);
    app = new Hono();
    app.route("/", createSecretsRoute(store));
});

describe("secrets API", () => {
    it("GET returns empty keys for unknown owner/app", async () => {
        const res = await app.request("/secrets/acme-corp/api");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ owner: "acme-corp", app: "api", keys: [] });
    });

    it("PUT saves a secret", async () => {
        const res = await app.request("/secrets/acme-corp/api/API_KEY", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "sk-123" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ owner: "acme-corp", app: "api", key: "API_KEY", status: "saved" });
    });

    it("GET lists saved secret keys", async () => {
        await app.request("/secrets/acme-corp/api/KEY_A", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "a" }),
        });
        await app.request("/secrets/acme-corp/api/KEY_B", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "b" }),
        });

        const res = await app.request("/secrets/acme-corp/api");
        const body = await res.json();
        expect(body.keys).toEqual(["KEY_A", "KEY_B"]);
    });

    it("DELETE removes a secret", async () => {
        await app.request("/secrets/acme-corp/api/KEY", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "val" }),
        });

        const res = await app.request("/secrets/acme-corp/api/KEY", {
            method: "DELETE",
        });
        expect(res.status).toBe(200);

        const listRes = await app.request("/secrets/acme-corp/api");
        const body = await listRes.json();
        expect(body.keys).toEqual([]);
    });

    it("DELETE returns 404 for non-existent secret", async () => {
        const res = await app.request("/secrets/acme-corp/api/NOPE", {
            method: "DELETE",
        });
        expect(res.status).toBe(404);
    });

    it("PUT rejects missing value", async () => {
        const res = await app.request("/secrets/acme-corp/api/KEY", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it("isolates secrets between apps", async () => {
        await app.request("/secrets/acme-corp/api/STRIPE_KEY", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "sk-stripe" }),
        });
        await app.request("/secrets/acme-corp/web/FIREBASE_KEY", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "fb-key" }),
        });

        const apiRes = await app.request("/secrets/acme-corp/api");
        const webRes = await app.request("/secrets/acme-corp/web");
        expect((await apiRes.json()).keys).toEqual(["STRIPE_KEY"]);
        expect((await webRes.json()).keys).toEqual(["FIREBASE_KEY"]);
    });
});
