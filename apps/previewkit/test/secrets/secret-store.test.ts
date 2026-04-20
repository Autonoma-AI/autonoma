import * as k8s from "@kubernetes/client-node";
import { describe, it, expect, beforeEach, vi } from "vitest";
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

    const kc = {
        makeApiClient: vi.fn(() => mockApi),
    } as unknown as k8s.KubeConfig;

    return { kc, mockApi, secrets };
}

let store: SecretStore;

beforeEach(() => {
    const { kc } = createMockKubeConfig();
    store = new SecretStore(kc);
});

describe("SecretStore", () => {
    it("returns empty object for unknown owner/app", async () => {
        const secrets = await store.get("acme-corp", "api");
        expect(secrets).toEqual({});
    });

    it("sets and gets a secret", async () => {
        await store.set("acme-corp", "api", "API_KEY", "sk-123");
        const secrets = await store.get("acme-corp", "api");
        expect(secrets.API_KEY).toBe("sk-123");
    });

    it("sets multiple secrets for the same app", async () => {
        await store.set("acme-corp", "api", "KEY_A", "value-a");
        await store.set("acme-corp", "api", "KEY_B", "value-b");
        const secrets = await store.get("acme-corp", "api");
        expect(secrets).toEqual({ KEY_A: "value-a", KEY_B: "value-b" });
    });

    it("overwrites an existing secret", async () => {
        await store.set("acme-corp", "api", "KEY", "old");
        await store.set("acme-corp", "api", "KEY", "new");
        const secrets = await store.get("acme-corp", "api");
        expect(secrets.KEY).toBe("new");
    });

    it("deletes a secret", async () => {
        await store.set("acme-corp", "api", "KEY_A", "a");
        await store.set("acme-corp", "api", "KEY_B", "b");
        const deleted = await store.delete("acme-corp", "api", "KEY_A");
        expect(deleted).toBe(true);
        const secrets = await store.get("acme-corp", "api");
        expect(secrets).toEqual({ KEY_B: "b" });
    });

    it("returns false when deleting non-existent secret", async () => {
        const deleted = await store.delete("acme-corp", "api", "NOPE");
        expect(deleted).toBe(false);
    });

    it("lists secret keys without values", async () => {
        await store.set("acme-corp", "api", "KEY_A", "a");
        await store.set("acme-corp", "api", "KEY_B", "b");
        const keys = await store.list("acme-corp", "api");
        expect(keys).toEqual(["KEY_A", "KEY_B"]);
    });

    it("isolates secrets between apps for the same owner", async () => {
        await store.set("acme-corp", "api", "STRIPE_KEY", "sk-stripe");
        await store.set("acme-corp", "web", "FIREBASE_KEY", "fb-key");

        const apiSecrets = await store.get("acme-corp", "api");
        const webSecrets = await store.get("acme-corp", "web");

        expect(apiSecrets).toEqual({ STRIPE_KEY: "sk-stripe" });
        expect(webSecrets).toEqual({ FIREBASE_KEY: "fb-key" });
    });

    it("isolates secrets between owners", async () => {
        await store.set("acme-corp", "api", "KEY", "value-a");
        await store.set("other-org", "api", "KEY", "value-b");
        expect((await store.get("acme-corp", "api")).KEY).toBe("value-a");
        expect((await store.get("other-org", "api")).KEY).toBe("value-b");
    });

    it("names K8s Secrets with owner and app", async () => {
        const { kc, secrets } = createMockKubeConfig();
        const s = new SecretStore(kc);
        await s.set("acme-corp", "api", "TOKEN", "hello");

        expect(secrets.has("previewkit-secrets-acme-corp-api")).toBe(true);
    });
});
