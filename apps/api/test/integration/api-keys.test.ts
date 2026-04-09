import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "api-keys",
    seed: async ({ harness }) => {
        // API keys service queries the member table, so we need a member record
        await harness.db.member.create({
            data: {
                userId: harness.userId,
                organizationId: harness.organizationId,
                role: "owner",
            },
        });

        // Seed an API key directly in the DB (BetterAuth's createApiKey has adapter issues in tests)
        const key = await harness.db.apiKey.create({
            data: {
                name: "Test Key",
                key: "hashed-key-value",
                start: "at_live_sk_test",
                userId: harness.userId,
            },
        });

        return { key };
    },
    cases: (test) => {
        test("list returns API keys for the organization", async ({ harness, seedResult }) => {
            const keys = await harness.request().apiKeys.list();
            expect(keys).toHaveLength(1);
            expect(keys[0]?.id).toBe(seedResult.key.id);
            expect(keys[0]?.name).toBe("Test Key");
            expect(keys[0]?.start).toBe("at_live_sk_test");
            expect(keys[0]?.user.id).toBe(harness.userId);
        });

        test("delete removes the key", async ({ harness, seedResult }) => {
            await harness.request().apiKeys.delete({ keyId: seedResult.key.id });
            const keys = await harness.request().apiKeys.list();
            expect(keys).toHaveLength(0);
        });

        test("delete with non-existent key throws error", async ({ harness }) => {
            await expect(harness.request().apiKeys.delete({ keyId: "non-existent-id" })).rejects.toBeInstanceOf(
                TRPCError,
            );
        });

        test("keys from another org are not visible", async ({ harness }) => {
            // Create a second org, user, and member
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: `other-org-${crypto.randomUUID()}` },
            });
            const otherUser = await harness.db.user.create({
                data: { name: "Other User", email: `other-${crypto.randomUUID()}@example.com`, emailVerified: true },
            });
            await harness.db.member.create({
                data: { userId: otherUser.id, organizationId: otherOrg.id, role: "owner" },
            });

            // Create an API key for the other user directly in DB
            await harness.db.apiKey.create({
                data: {
                    name: "Other Org Key",
                    key: "hashed-other-key",
                    start: "at_live_sk_other",
                    userId: otherUser.id,
                },
            });

            // The current org's list should not include the other org's key
            const keys = await harness.request().apiKeys.list();
            const names = keys.map((k) => k.name);
            expect(names).not.toContain("Other Org Key");
        });

        test("delete key from another org throws error", async ({ harness }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Isolated Org", slug: `isolated-org-${crypto.randomUUID()}` },
            });
            const otherUser = await harness.db.user.create({
                data: {
                    name: "Isolated User",
                    email: `isolated-${crypto.randomUUID()}@example.com`,
                    emailVerified: true,
                },
            });
            await harness.db.member.create({
                data: { userId: otherUser.id, organizationId: otherOrg.id, role: "owner" },
            });
            const otherKey = await harness.db.apiKey.create({
                data: {
                    name: "Isolated Key",
                    key: "hashed-isolated-key",
                    start: "at_live_sk_iso",
                    userId: otherUser.id,
                },
            });

            // Trying to delete a key that belongs to another org should throw
            await expect(harness.request().apiKeys.delete({ keyId: otherKey.id })).rejects.toBeInstanceOf(TRPCError);
        });
    },
});
