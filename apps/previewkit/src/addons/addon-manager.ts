import { db, type PrismaClient } from "@autonoma/db";
import type { AddonConfig } from "../config/schema";
import { logger as rootLogger, type Logger } from "../logger";
import type { OrgSecretResolver } from "./org-secret-resolver";
import type { ProvisionResult } from "./provider";
import type { AddonProviderRegistry } from "./registry";

/**
 * Per-addon outcome surfaced to the pipeline for templating + reporting.
 *
 * - `ok`: provider returned outputs; templates can substitute them into app
 *   env / build_args. `fresh` distinguishes a just-provisioned run from a
 *   cached replay (useful for logging / telemetry, but the templates don't
 *   care either way).
 * - `failed`: provider threw OR the org secret was missing OR options were
 *   invalid. The error is persisted on the row so subsequent dashboards
 *   can show *why*; on the next push we retry.
 */
export type AddonProvisionOutcome =
    | { name: string; status: "ok"; outputs: Record<string, string>; fresh: boolean }
    | { name: string; status: "failed"; error: string };

export class AddonManager {
    private readonly logger: Logger;

    constructor(
        private readonly registry: AddonProviderRegistry,
        private readonly orgSecretResolver: OrgSecretResolver,
        private readonly prisma: PrismaClient = db,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Provisions every addon declared in `.preview.yaml`. Each addon is its
     * own failure domain — one failed addon does not abort the others.
     *
     * Caching: rows with `status = ok` replay their cached outputs without
     * touching the provider's API. Any other status (or a missing row) is
     * re-attempted on this push — that's the retry-on-re-push semantic.
     */
    async provisionAll(
        environmentId: string,
        organizationId: string,
        namespace: string,
        prNumber: number,
        addons: AddonConfig[],
    ): Promise<AddonProvisionOutcome[]> {
        if (addons.length === 0) return [];

        this.logger.info("Provisioning addons", {
            environmentId,
            organizationId,
            namespace,
            prNumber,
            count: addons.length,
        });

        const settled = await Promise.allSettled(
            addons.map((addon) => this.provisionOne(environmentId, organizationId, namespace, prNumber, addon)),
        );

        const outcomes: AddonProvisionOutcome[] = [];
        for (let i = 0; i < addons.length; i++) {
            const addon = addons[i]!;
            const result = settled[i]!;
            if (result.status === "fulfilled") {
                outcomes.push(result.value);
                continue;
            }
            // provisionOne is supposed to convert exceptions into outcomes
            // itself — this branch is purely defensive. Still record the
            // failure so the pipeline can surface it.
            const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
            this.logger.error("Addon provisioning unexpectedly rejected", result.reason, { addon: addon.name });
            outcomes.push({ name: addon.name, status: "failed", error });
        }
        return outcomes;
    }

    /**
     * Deprovisions every still-live addon for the given environment.
     * Best-effort: per-addon failures are logged but don't abort the rest.
     * Callers (teardown) must not let an addon-API outage block namespace
     * deletion — orphans are recoverable, stuck namespaces are not.
     */
    async deprovisionAll(environmentId: string, organizationId: string): Promise<void> {
        const live = await this.prisma.previewkitAddon.findMany({
            where: { environmentId, status: "ok", deprovisionedAt: null },
        });
        if (live.length === 0) return;

        this.logger.info("Deprovisioning addons", { environmentId, organizationId, count: live.length });

        await Promise.allSettled(
            live.map(async (row) => {
                try {
                    const provider = this.registry.get(row.provider);
                    // Look up the addon's auth_secret from the most recent
                    // `.preview.yaml` reference. The config isn't available at
                    // teardown time (the PR may be closed against any ref), so
                    // we persist the options on the row's `state.options` blob.
                    // For now: re-derive from a separate `options` column would
                    // be the long-term shape; the addon row needs to carry
                    // enough info for an independent teardown.
                    const authSecretName = (row.state as { authSecretName?: string }).authSecretName;
                    const options = (row.state as { options?: Record<string, unknown> }).options ?? {};
                    if (authSecretName == null) {
                        throw new Error(
                            `Addon row ${row.id} (${row.name}) has no authSecretName on its state — ` +
                                `cannot resolve credentials for deprovision`,
                        );
                    }
                    const authSecret = await this.orgSecretResolver.resolve(organizationId, authSecretName);

                    await provider.deprovision({
                        options,
                        authSecret,
                        state: (row.state as { providerState?: Record<string, unknown> }).providerState ?? {},
                    });

                    await this.prisma.previewkitAddon.update({
                        where: { id: row.id },
                        data: { status: "deprovisioned", deprovisionedAt: new Date(), error: null },
                    });
                    this.logger.info("Addon deprovisioned", { addon: row.name, provider: row.provider });
                } catch (err) {
                    this.logger.error("Addon deprovision failed (continuing)", err, {
                        addon: row.name,
                        provider: row.provider,
                    });
                    await this.prisma.previewkitAddon.update({
                        where: { id: row.id },
                        data: { error: err instanceof Error ? err.message : String(err) },
                    });
                }
            }),
        );
    }

    private async provisionOne(
        environmentId: string,
        organizationId: string,
        namespace: string,
        prNumber: number,
        addon: AddonConfig,
    ): Promise<AddonProvisionOutcome> {
        const existing = await this.prisma.previewkitAddon.findUnique({
            where: { environmentId_name: { environmentId, name: addon.name } },
        });

        // Cached success path — replay outputs without re-calling the provider.
        // This is what makes Neon branches persist across pushes (the natural
        // model: the branch IS the preview environment for this PR).
        if (existing?.status === "ok" && existing.deprovisionedAt == null) {
            const cached = existing.outputs as Record<string, string>;
            this.logger.info("Reusing cached addon outputs", { addon: addon.name, provider: addon.provider });
            return { name: addon.name, status: "ok", outputs: cached, fresh: false };
        }

        // Retry path (or first provision). Mark as pending, then call the
        // provider. On success → row carries ok + outputs + state. On
        // failure → row carries failed + error message for the next push
        // to inspect.
        await this.upsertPending(environmentId, addon);

        try {
            const provider = this.registry.get(addon.provider);
            const authSecret = await this.orgSecretResolver.resolve(organizationId, addon.auth_secret);

            const result = await provider.provision({
                options: addon.options,
                authSecret,
                prNumber,
                namespace,
                organizationId,
            });

            await this.persistSuccess(environmentId, addon, authSecret, result);
            this.logger.info("Addon provisioned", { addon: addon.name, provider: addon.provider });
            return { name: addon.name, status: "ok", outputs: result.outputs, fresh: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error("Addon provisioning failed", err, { addon: addon.name, provider: addon.provider });
            await this.persistFailure(environmentId, addon, message);
            return { name: addon.name, status: "failed", error: message };
        }
    }

    private async upsertPending(environmentId: string, addon: AddonConfig): Promise<void> {
        await this.prisma.previewkitAddon.upsert({
            where: { environmentId_name: { environmentId, name: addon.name } },
            create: {
                environmentId,
                name: addon.name,
                provider: addon.provider,
                status: "pending",
            },
            update: {
                provider: addon.provider,
                status: "pending",
                error: null,
                deprovisionedAt: null,
            },
        });
    }

    private async persistSuccess(
        environmentId: string,
        addon: AddonConfig,
        authSecret: Record<string, string>,
        result: ProvisionResult,
    ): Promise<void> {
        // Persist enough context on the row for an independent teardown:
        // the auth_secret name (so we can re-resolve creds at PR-close time
        // without re-reading `.preview.yaml`), the provider-specific options,
        // and the provider's opaque state blob. We deliberately do NOT
        // store the auth secret value itself — only its name.
        void authSecret;
        const state = {
            authSecretName: addon.auth_secret,
            options: addon.options,
            providerState: result.state,
        };

        await this.prisma.previewkitAddon.update({
            where: { environmentId_name: { environmentId, name: addon.name } },
            data: {
                status: "ok",
                error: null,
                state,
                outputs: result.outputs,
                provisionedAt: new Date(),
                deprovisionedAt: null,
            },
        });
    }

    private async persistFailure(environmentId: string, addon: AddonConfig, error: string): Promise<void> {
        await this.prisma.previewkitAddon.update({
            where: { environmentId_name: { environmentId, name: addon.name } },
            data: { status: "failed", error },
        });
    }
}
