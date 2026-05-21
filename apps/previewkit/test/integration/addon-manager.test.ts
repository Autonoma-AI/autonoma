import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { AddonManager } from "../../src/addons/addon-manager";
import type { OrgSecretResolver } from "../../src/addons/org-secret-resolver";
import type { AddonProvider, DeprovisionInput, ProvisionInput, ProvisionResult } from "../../src/addons/provider";
import { AddonProviderRegistry } from "../../src/addons/registry";
import { recordEnvironmentCreated } from "../../src/db";
import { PreviewkitTestHarness } from "./harness";

class ScriptedProvider implements AddonProvider {
    readonly name = "scripted";
    provisionCalls = 0;
    deprovisionCalls = 0;
    nextProvision: ProvisionResult | Error = { outputs: { url: "ok" }, state: { id: "s1" } };
    nextDeprovision: void | Error = undefined;

    async provision(_input: ProvisionInput): Promise<ProvisionResult> {
        this.provisionCalls++;
        if (this.nextProvision instanceof Error) throw this.nextProvision;
        return this.nextProvision;
    }

    async deprovision(_input: DeprovisionInput): Promise<void> {
        this.deprovisionCalls++;
        if (this.nextDeprovision instanceof Error) throw this.nextDeprovision;
    }
}

function stubOrgSecretResolver(map: Record<string, string> = { token: "fake-token" }): OrgSecretResolver {
    // Duck-typed stub — the manager only ever calls .resolve(). Avoids
    // standing up real AWS Secrets Manager for these tests.
    return { resolve: async () => map } as unknown as OrgSecretResolver;
}

const addonConfig = {
    name: "db",
    provider: "scripted",
    auth_secret: "scripted-key",
    options: { foo: "bar" },
};

integrationTestSuite({
    name: "AddonManager",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        test("first-time provision persists state, outputs, and provisionedAt", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 1,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-1",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-1" },
            }))!;

            const provider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(provider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            const outcomes = await manager.provisionAll(env.id, organizationId, env.namespace, 1, [addonConfig]);

            expect(outcomes).toHaveLength(1);
            expect(outcomes[0]).toMatchObject({ name: "db", status: "ok", fresh: true });
            expect(provider.provisionCalls).toBe(1);

            const row = await harness.db.previewkitAddon.findUnique({
                where: { environmentId_name: { environmentId: env.id, name: "db" } },
            });
            expect(row).not.toBeNull();
            expect(row!.status).toBe("ok");
            expect(row!.provider).toBe("scripted");
            expect(row!.provisionedAt).not.toBeNull();
            // The manager persists enough state to drive an independent
            // teardown — the auth_secret name and the provider's opaque state
            // both have to land on the row.
            expect(row!.state).toMatchObject({
                authSecretName: "scripted-key",
                providerState: { id: "s1" },
            });
            expect(row!.outputs).toMatchObject({ url: "ok" });
        });

        test("second provision reuses cached outputs without calling the provider", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 2,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-2",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-2" },
            }))!;

            const provider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(provider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            await manager.provisionAll(env.id, organizationId, env.namespace, 2, [addonConfig]);
            const outcomes = await manager.provisionAll(env.id, organizationId, env.namespace, 2, [addonConfig]);

            expect(provider.provisionCalls).toBe(1);
            expect(outcomes[0]).toMatchObject({ status: "ok", fresh: false, outputs: { url: "ok" } });
        });

        test("retry path: a failed row is re-attempted on the next push", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 3,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-3",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-3" },
            }))!;

            const provider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(provider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            // First push: provider throws → row is persisted as failed.
            provider.nextProvision = new Error("transient API hiccup");
            const first = await manager.provisionAll(env.id, organizationId, env.namespace, 3, [addonConfig]);
            expect(first[0]).toMatchObject({ status: "failed" });
            const failedRow = await harness.db.previewkitAddon.findUnique({
                where: { environmentId_name: { environmentId: env.id, name: "db" } },
            });
            expect(failedRow!.status).toBe("failed");
            expect(failedRow!.error).toMatch(/transient API hiccup/);

            // Second push: provider succeeds → status flips to ok, outputs land.
            provider.nextProvision = { outputs: { url: "now-ok" }, state: { id: "s2" } };
            const second = await manager.provisionAll(env.id, organizationId, env.namespace, 3, [addonConfig]);
            expect(second[0]).toMatchObject({ status: "ok", fresh: true, outputs: { url: "now-ok" } });
            const okRow = await harness.db.previewkitAddon.findUnique({
                where: { environmentId_name: { environmentId: env.id, name: "db" } },
            });
            expect(okRow!.status).toBe("ok");
            expect(okRow!.error).toBeNull();
            expect(provider.provisionCalls).toBe(2);
        });

        test("one addon failing does not abort the rest (allSettled semantics)", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 4,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-4",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-4" },
            }))!;

            const flakyProvider: AddonProvider = {
                name: "flaky",
                provision: async () => {
                    throw new Error("boom");
                },
                deprovision: async () => {},
            };
            const okProvider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(flakyProvider);
            registry.register(okProvider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            const outcomes = await manager.provisionAll(env.id, organizationId, env.namespace, 4, [
                { name: "flaky-db", provider: "flaky", auth_secret: "k", options: {} },
                { name: "ok-db", provider: "scripted", auth_secret: "k", options: {} },
            ]);

            expect(outcomes).toHaveLength(2);
            const flaky = outcomes.find((o) => o.name === "flaky-db")!;
            const ok = outcomes.find((o) => o.name === "ok-db")!;
            expect(flaky.status).toBe("failed");
            expect(ok.status).toBe("ok");
        });

        test("deprovisionAll deletes live addons + stamps deprovisionedAt", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 5,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-5",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-5" },
            }))!;

            const provider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(provider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            await manager.provisionAll(env.id, organizationId, env.namespace, 5, [addonConfig]);

            await manager.deprovisionAll(env.id, organizationId);

            expect(provider.deprovisionCalls).toBe(1);
            const row = await harness.db.previewkitAddon.findUnique({
                where: { environmentId_name: { environmentId: env.id, name: "db" } },
            });
            expect(row!.status).toBe("deprovisioned");
            expect(row!.deprovisionedAt).not.toBeNull();
        });

        test("deprovision failure does not block the rest, logs error on row", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 6,
                headSha: "sha",
                headRef: "main",
                namespace: "preview-acme-web-pr-6",
            });
            const env = (await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-6" },
            }))!;

            const provider = new ScriptedProvider();
            const registry = new AddonProviderRegistry();
            registry.register(provider);
            const manager = new AddonManager(registry, stubOrgSecretResolver());

            await manager.provisionAll(env.id, organizationId, env.namespace, 6, [addonConfig]);
            provider.nextDeprovision = new Error("api down");

            // deprovisionAll never throws — it's best-effort by design.
            await manager.deprovisionAll(env.id, organizationId);

            const row = await harness.db.previewkitAddon.findUnique({
                where: { environmentId_name: { environmentId: env.id, name: "db" } },
            });
            // Still "ok" because deprovision failed — the row stays live so
            // the reconciler can pick it up on its next pass.
            expect(row!.status).toBe("ok");
            expect(row!.deprovisionedAt).toBeNull();
            expect(row!.error).toMatch(/api down/);
        });
    },
});
