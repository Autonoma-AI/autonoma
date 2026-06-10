import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PreviewkitClient } from "../../../src/previewkit/previewkit-client";

interface ReceivedRequest {
    method: string;
    path: string;
    search: string;
    authorization: string | undefined;
    body: string;
}

/** Encode a string as a standalone ArrayBuffer (what the proxy forwards as the body). */
function toArrayBuffer(text: string): ArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}

describe("PreviewkitClient", () => {
    let server: ReturnType<typeof serve>;
    let baseUrl: string;
    let received: ReceivedRequest | undefined;
    let stubStatus = 200;
    let stubBody: unknown = { ok: true };

    beforeAll(async () => {
        // Stub Previewkit: records what it received and replies with the configured status/body.
        const stub = new Hono().all("/v1/*", async (c) => {
            const url = new URL(c.req.url);
            received = {
                method: c.req.method,
                path: url.pathname,
                search: url.search,
                authorization: c.req.header("authorization"),
                body: await c.req.text(),
            };
            return new Response(JSON.stringify(stubBody), {
                status: stubStatus,
                headers: { "content-type": "application/json" },
            });
        });

        await new Promise<void>((resolve) => {
            server = serve({ fetch: stub.fetch, port: 0 }, (info) => {
                baseUrl = `http://localhost:${info.port}`;
                resolve();
            });
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        received = undefined;
        stubStatus = 200;
        stubBody = { ok: true };
    });

    it("reports configuration state from its constructor args", () => {
        expect(new PreviewkitClient(undefined, undefined).hasBaseUrl()).toBe(false);
        expect(new PreviewkitClient("http://x", undefined).hasBaseUrl()).toBe(true);
        expect(new PreviewkitClient("http://x", undefined).isConfigured()).toBe(false);
        expect(new PreviewkitClient("http://x", "secret").isConfigured()).toBe(true);
    });

    it("forwards method, path, query, body and the caller's own Authorization header verbatim", async () => {
        stubStatus = 201;
        stubBody = { saved: true };
        const client = new PreviewkitClient(baseUrl, "service-secret");

        const result = await client.forward({
            method: "PUT",
            subPath: "secrets/app_abc/web",
            authorization: "Bearer ak_live_caller",
            contentType: "application/json",
            searchParams: "foo=bar",
            body: toArrayBuffer(JSON.stringify({ items: [{ key: "K", value: "V" }] })),
        });

        // Previewkit's response is returned verbatim.
        expect(result.status).toBe(201);
        expect(JSON.parse(result.body)).toEqual({ saved: true });

        // The request reached Previewkit unchanged...
        expect(received?.method).toBe("PUT");
        expect(received?.path).toBe("/v1/secrets/app_abc/web");
        expect(received?.search).toBe("?foo=bar");
        expect(JSON.parse(received?.body ?? "{}")).toEqual({ items: [{ key: "K", value: "V" }] });
        // ...crucially with the CALLER's credential, never the service secret (preserves org-scoping).
        expect(received?.authorization).toBe("Bearer ak_live_caller");
    });

    it("forwards GET requests with no body and strips a trailing slash from the base URL", async () => {
        const client = new PreviewkitClient(`${baseUrl}/`, "service-secret");

        await client.forward({
            method: "GET",
            subPath: "openapi.json",
            authorization: undefined,
            contentType: undefined,
            searchParams: "",
            body: undefined,
        });

        expect(received?.method).toBe("GET");
        expect(received?.path).toBe("/v1/openapi.json");
        expect(received?.search).toBe("");
        expect(received?.body).toBe("");
    });

    it("deploy posts the event to Previewkit authenticated with the service secret", async () => {
        stubStatus = 202;
        stubBody = { accepted: true };
        const client = new PreviewkitClient(baseUrl, "service-secret");

        await client.deploy({
            repoFullName: "owner/repo",
            prNumber: 3,
            organizationId: "org_1",
            githubRepositoryId: 9,
            headSha: "abc",
            headRef: "feature",
            cloneUrl: "https://github.com/owner/repo.git",
        });

        expect(received?.method).toBe("POST");
        expect(received?.path).toBe("/v1/environments");
        expect(received?.authorization).toBe("Bearer service-secret");
        expect(JSON.parse(received?.body ?? "{}")).toMatchObject({ repoFullName: "owner/repo", prNumber: 3 });
    });

    it("teardown tolerates a 404 but throws on other errors", async () => {
        const client = new PreviewkitClient(baseUrl, "service-secret");

        stubStatus = 404;
        await expect(
            client.teardown({
                repoFullName: "owner/repo",
                prNumber: 5,
                organizationId: "org_1",
                githubRepositoryId: 9,
            }),
        ).resolves.toBeUndefined();
        expect(received?.method).toBe("DELETE");
        expect(received?.path).toBe("/v1/environments/owner/repo/5");
        expect(received?.search).toContain("organizationId=org_1");
        expect(received?.search).toContain("githubRepositoryId=9");

        stubStatus = 500;
        await expect(
            client.teardown({
                repoFullName: "owner/repo",
                prNumber: 5,
                organizationId: "org_1",
                githubRepositoryId: 9,
            }),
        ).rejects.toThrow(/500/);
    });

    it("redeploy surfaces Previewkit's own error detail", async () => {
        stubStatus = 409;
        stubBody = { error: "Environment has been torn down and cannot be redeployed" };
        const client = new PreviewkitClient(baseUrl, "service-secret");

        await expect(client.redeploy("owner/repo", 7)).rejects.toThrow(/torn down/);
        expect(received?.path).toBe("/v1/environments/owner/repo/7/redeploy");
    });

    it("deployMainBranch posts to the application's environment-0 path with the service secret", async () => {
        stubStatus = 202;
        stubBody = { accepted: true };
        const client = new PreviewkitClient(baseUrl, "service-secret");

        await client.deployMainBranch("app_abc");

        expect(received?.method).toBe("POST");
        expect(received?.path).toBe("/v1/applications/app_abc/0");
        expect(received?.authorization).toBe("Bearer service-secret");
    });

    it("deployMainBranch surfaces Previewkit's own error detail", async () => {
        stubStatus = 409;
        stubBody = { error: "Application is disabled and cannot be deployed" };
        const client = new PreviewkitClient(baseUrl, "service-secret");

        await expect(client.deployMainBranch("app_abc")).rejects.toThrow(/disabled/);
    });
});
