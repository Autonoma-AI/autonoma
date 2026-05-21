import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeonProvider } from "../../../src/addons/providers/neon";

interface FakeCall {
    method: string;
    url: string;
    body?: unknown;
    authHeader?: string;
}

function setupFetch(): {
    calls: FakeCall[];
    respond: (resp: { ok?: boolean; status?: number; body: unknown }) => void;
} {
    const calls: FakeCall[] = [];
    const queue: Array<{ ok: boolean; status: number; body: unknown }> = [];

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        const body = init.body != null ? JSON.parse(init.body as string) : undefined;
        const headers = init.headers as Record<string, string> | undefined;
        calls.push({ method, url, body, authHeader: headers?.Authorization });

        const next = queue.shift();
        if (next == null) {
            return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify(next.body), {
            status: next.status,
            headers: { "Content-Type": "application/json" },
        });
    });

    return {
        calls,
        respond: (resp) => queue.push({ ok: resp.ok ?? true, status: resp.status ?? 200, body: resp.body }),
    };
}

const provisionInput = {
    options: { project_id: "epic-water-12345", parent_branch_id: "br_main", database_name: "myapp" },
    authSecret: { token: "neon_test_token" },
    prNumber: 42,
    namespace: "preview-acme-app-pr-42",
    organizationId: "org_123",
};

describe("NeonProvider", () => {
    let fetchMock: ReturnType<typeof setupFetch>;

    beforeEach(() => {
        fetchMock = setupFetch();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("creates a branch + fetches the connection URI and returns expected outputs/state", async () => {
        fetchMock.respond({
            body: {
                branch: { id: "br_xyz" },
                endpoints: [{ id: "ep_xyz", host: "ep-foo.us-east-2.aws.neon.tech" }],
            },
        });
        fetchMock.respond({
            body: { uri: "postgres://u:p@ep-foo.us-east-2.aws.neon.tech/myapp?sslmode=require" },
        });

        const provider = new NeonProvider();
        const result = await provider.provision(provisionInput);

        expect(result.outputs).toEqual({
            connectionString: "postgres://u:p@ep-foo.us-east-2.aws.neon.tech/myapp?sslmode=require",
            host: "ep-foo.us-east-2.aws.neon.tech",
            database: "myapp",
        });
        expect(result.state).toEqual({ branchId: "br_xyz", endpointId: "ep_xyz" });

        // Sanity-check that we actually called Neon with the right shape.
        expect(fetchMock.calls).toHaveLength(2);
        expect(fetchMock.calls[0]!.method).toBe("POST");
        expect(fetchMock.calls[0]!.url).toContain("/projects/epic-water-12345/branches");
        expect(fetchMock.calls[0]!.authHeader).toBe("Bearer neon_test_token");
        expect(fetchMock.calls[0]!.body).toMatchObject({
            branch: { name: "previewkit-pr-42", parent_id: "br_main" },
            endpoints: [{ type: "read_write" }],
        });
        expect(fetchMock.calls[1]!.url).toContain("connection_uri?branch_id=br_xyz");
    });

    it("omits parent_id when parent_branch_id is not configured (defaults to Neon's primary)", async () => {
        fetchMock.respond({
            body: { branch: { id: "br_a" }, endpoints: [{ id: "ep_a", host: "h" }] },
        });
        fetchMock.respond({ body: { uri: "postgres://x" } });

        const provider = new NeonProvider();
        await provider.provision({
            ...provisionInput,
            options: { project_id: "epic-water-12345" },
        });

        expect(fetchMock.calls[0]!.body).toMatchObject({
            branch: { name: "previewkit-pr-42" },
            endpoints: [{ type: "read_write" }],
        });
        // Crucially the body should NOT carry a parent_id when unspecified —
        // sending one defeats the point of the optional default.
        const branchBody = (fetchMock.calls[0]!.body as { branch: Record<string, unknown> }).branch;
        expect("parent_id" in branchBody).toBe(false);
    });

    it("surfaces Neon API errors with the status code and response body included", async () => {
        // Single 422 from the branch-create call is enough — the provider
        // should bail before issuing the connection_uri request.
        fetchMock.respond({ ok: false, status: 422, body: { message: "branch already exists" } });

        const provider = new NeonProvider();
        await expect(provider.provision(provisionInput)).rejects.toThrow(/422.*branch already exists/);

        // And only one request should have left the building — error path
        // does not optimistically continue to the connection_uri call.
        expect(fetchMock.calls).toHaveLength(1);
    });

    it("rejects options missing required project_id", async () => {
        const provider = new NeonProvider();
        await expect(provider.provision({ ...provisionInput, options: {} })).rejects.toThrow(/project_id/);
    });

    it("rejects auth secret missing the `token` key", async () => {
        const provider = new NeonProvider();
        await expect(provider.provision({ ...provisionInput, authSecret: {} })).rejects.toThrow(/token/);
    });

    it("deprovision DELETEs the branch under the project", async () => {
        fetchMock.respond({ body: {} });

        const provider = new NeonProvider();
        await provider.deprovision({
            options: { project_id: "epic-water-12345" },
            authSecret: { token: "neon_test_token" },
            state: { branchId: "br_xyz" },
        });

        expect(fetchMock.calls).toHaveLength(1);
        expect(fetchMock.calls[0]!.method).toBe("DELETE");
        expect(fetchMock.calls[0]!.url).toContain("/projects/epic-water-12345/branches/br_xyz");
        expect(fetchMock.calls[0]!.authHeader).toBe("Bearer neon_test_token");
    });
});
