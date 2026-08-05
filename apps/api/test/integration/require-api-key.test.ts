import { hashApiKey, requireApiKey, type UserAuthVariables } from "@autonoma/auth";
import { Hono } from "hono";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

/**
 * The API key is the only way into an authenticated route, and it carries the organization every handler scopes
 * to. Pinned here because an org-less caller would silently widen every previewkit lookup to all organizations.
 */

// A distinct key per case: the suite shares one database, and `verifyApiKey` matches on the hash alone, so a
// key left enabled by an earlier case would satisfy a later one.
const ENABLED_KEY = "ak_test_enabled_a1b2c3";
const DISABLED_KEY = "ak_test_disabled_d4e5f6";

function appUnder(harness: APITestHarness) {
    return new Hono<{ Variables: UserAuthVariables }>()
        .use("/scoped", requireApiKey({ db: harness.db }))
        .get("/scoped", (c) => c.json({ organizationId: c.var.user.organizationId, userId: c.var.user.userId }));
}

function get(harness: APITestHarness, authorization?: string): Promise<Response> {
    return appUnder(harness).request("/scoped", authorization != null ? { headers: { authorization } } : {});
}

async function createKey(harness: APITestHarness, rawKey: string, enabled: boolean): Promise<void> {
    await harness.db.apiKey.create({
        data: {
            key: hashApiKey(rawKey),
            name: "test",
            enabled,
            userId: harness.userId,
            organizationId: harness.organizationId,
        },
    });
}

apiTestSuite({
    name: "requireApiKey",
    cases: (test) => {
        test("an enabled key authenticates and carries its organization", async ({ harness }) => {
            await createKey(harness, ENABLED_KEY, true);

            const response = await get(harness, `Bearer ${ENABLED_KEY}`);

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
                organizationId: harness.organizationId,
                userId: harness.userId,
            });
        });

        // A bearer token that is not an API key must never authenticate.
        test("an arbitrary bearer secret is rejected", async ({ harness }) => {
            const response = await get(harness, "Bearer some-shared-service-secret");

            expect(response.status).toBe(401);
        });

        test("a disabled key is rejected", async ({ harness }) => {
            await createKey(harness, DISABLED_KEY, false);

            const response = await get(harness, `Bearer ${DISABLED_KEY}`);

            expect(response.status).toBe(401);
        });

        test("no authorization header is rejected", async ({ harness }) => {
            const response = await get(harness);

            expect(response.status).toBe(401);
        });
    },
});
