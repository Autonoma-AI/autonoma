import { sleep } from "@autonoma/utils/sleep";
import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { isConflict, isNotFound } from "../deployer/k8s-errors";
import { PreviewPlatformError } from "../errors";
import { type Logger, logger as rootLogger } from "../logger";
import type { AppSecretInfo, RuntimeSecretMaterializer, SecretTarget } from "./runtime-secret-materializer";
import { EXTERNAL_SECRET_TYPE, MANAGED_BY_PREVIEWKIT, POSTGRES_SECRET_TYPE, SECRET_LABEL } from "./secret-labels";

const ESO_GROUP = "external-secrets.io";
const ESO_VERSION = "v1";
const ESO_PLURAL = "externalsecrets";

// ESO honours a changing `force-sync` annotation as a request to reconcile the
// ExternalSecret immediately, so a redeploy picks up a rotated secret without
// waiting for the 5m refresh interval. Any annotation change also re-triggers
// the controller's watch, so this doubles as a guaranteed reconcile trigger.
const FORCE_SYNC_ANNOTATION = "force-sync";

// How long the deployer blocks waiting for ESO to materialise each app's K8s
// Secret before it rolls out the app pods. Bounded so a stuck sync fails the
// deploy cleanly instead of booting a pod with a missing/stale secret.
const SECRET_SYNC_TIMEOUT_MS = 120_000;
const SECRET_SYNC_POLL_INTERVAL_MS = 2_000;
// Tolerance for clock skew between this runner and the ESO controller when
// comparing our force-sync request time against the reported `refreshTime`.
const SECRET_SYNC_CLOCK_SKEW_MS = 5_000;

const ExternalSecretStatusSchema = z.object({
    status: z
        .object({
            refreshTime: z.string().nullish(),
            conditions: z.array(z.object({ type: z.string(), status: z.string() })).nullish(),
        })
        .nullish(),
});

/** Just enough of an existing CR to carry its resourceVersion into a replace. */
const ExternalSecretMetadataSchema = z.object({
    metadata: z.object({ resourceVersion: z.string().nullish() }).nullish(),
});

const ExternalSecretListSchema = z.object({
    items: z.array(
        z.object({
            metadata: z.object({ name: z.string().nullish() }).nullish(),
            spec: z.object({ target: z.object({ name: z.string().nullish() }).nullish() }).nullish(),
        }),
    ),
});

/** The ExternalSecret CR name for a PreviewkitSecret row - stable across redeploys. */
function externalSecretName(recordId: string): string {
    return `previewkit-aws-${recordId}`;
}

interface ExternalSecret {
    apiVersion: "external-secrets.io/v1";
    kind: "ExternalSecret";
    metadata: {
        name: string;
        namespace: string;
        labels: Record<string, string>;
        annotations?: Record<string, string>;
    };
    spec: {
        refreshInterval: string;
        secretStoreRef: { name: string; kind: "ClusterSecretStore" };
        target: { name: string; creationPolicy: "Owner" };
        dataFrom: Array<{ extract: { key: string } }>;
    };
}

/** The ExternalSecret CR calls this needs; `k8s.CustomObjectsApi` satisfies it. */
export interface ExternalSecretApi {
    createNamespacedCustomObject(params: CustomObjectRef & { body: ExternalSecret }): Promise<unknown>;
    replaceNamespacedCustomObject(params: CustomObjectRef & { name: string; body: object }): Promise<unknown>;
    getNamespacedCustomObject(params: CustomObjectRef & { name: string }): Promise<unknown>;
    deleteNamespacedCustomObject(
        params: CustomObjectRef & { name: string; body?: k8s.V1DeleteOptions },
    ): Promise<unknown>;
    listNamespacedCustomObject(params: CustomObjectRef & { labelSelector?: string }): Promise<unknown>;
}

/** The K8s Secret calls this needs; `k8s.CoreV1Api` satisfies it. */
export interface SecretApi {
    readNamespacedSecret(params: { name: string; namespace: string }): Promise<k8s.V1Secret>;
    deleteNamespacedSecret(params: { name: string; namespace: string }): Promise<unknown>;
}

interface CustomObjectRef {
    group: string;
    version: string;
    namespace: string;
    plural: string;
}

export class AwsExternalSecretManager implements RuntimeSecretMaterializer {
    private readonly logger: Logger;

    constructor(
        private readonly customApi: ExternalSecretApi,
        private readonly coreApi: SecretApi,
        private readonly clusterSecretStoreName: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Creates one ExternalSecret CR per target, each pointing at its own AWS SM
     * ARN. Each app's secret is independently IAM-scoped - adding a new app to the
     * monorepo requires registering its own PreviewkitSecret row pointing at its
     * own AWS SM ARN.
     *
     * Blocks until ESO has materialised each target K8s Secret from the current
     * AWS value (force-syncing first to skip the 5m refresh) BEFORE returning,
     * so the deployer never rolls out a pod that references a Secret ESO has not
     * populated yet (or has not refreshed after a rotation) - the root cause of
     * the deterministic "ready pod with a missing/stale AUTONOMA_SHARED_SECRET ->
     * every signed SDK call 401s" failure. Throws on sync timeout so the deploy
     * fails cleanly instead.
     */
    async materialize(
        namespace: string,
        organizationId: string,
        targets: SecretTarget[],
    ): Promise<Map<string, AppSecretInfo>> {
        const result = new Map<string, AppSecretInfo>();
        if (targets.length === 0) return result;

        this.logger.info("Applying AWS ExternalSecrets for namespace", {
            organizationId,
            namespace,
            extra: { apps: targets.map((target) => target.record.appName) },
        });

        // A Secret a previous deploy wrote from Postgres has no ExternalSecret owner,
        // and ESO refuses to adopt a target it does not own - so without this, going
        // back to aws would hang every affected app at the pre-rollout wait.
        await this.reclaimTargets(
            namespace,
            targets.map(({ secretName }) => secretName),
        );

        // Reconcile the namespace to exactly these ExternalSecrets before rolling
        // out. A soft-deleted app generation leaves its Owner ExternalSecret behind
        // in the reused -pr-0 namespace (soft delete never cleans up secrets, and
        // the ns-cleaner CronJob skips -pr-0); that leftover keeps owning the target
        // K8s Secret, so the new generation's ExternalSecret can never sync and the
        // deploy times out. Prune any stale ExternalSecret that targets an app we
        // are deploying now, so the current one can own the Secret cleanly.
        const desiredEsNames = new Set(targets.map(({ record }) => externalSecretName(record.id)));
        const desiredTargets = new Set(targets.map(({ secretName }) => secretName));
        await this.pruneCollidingExternalSecrets(namespace, desiredEsNames, desiredTargets);

        // Stamp one force-sync token for the batch and remember when we asked,
        // so the readiness wait can require a reconcile that happened after it.
        const syncRequestedAtMs = Date.now();
        const forceSyncToken = new Date(syncRequestedAtMs).toISOString();
        const pending = await Promise.all(
            targets.map(async ({ record, secretName }) => {
                const resource = this.buildExternalSecret(
                    record,
                    secretName,
                    namespace,
                    organizationId,
                    forceSyncToken,
                );
                await this.applyExternalSecret(namespace, resource);

                this.logger.info("Applied AWS ExternalSecret", {
                    appName: record.appName,
                    k8sSecretName: secretName,
                    awsSecretArn: record.awsSecretArn,
                    namespace,
                    extra: { esName: resource.metadata.name },
                });
                return { appName: record.appName, esName: resource.metadata.name, secretName };
            }),
        );

        // The ExternalSecrets are all applied above, so their syncs are
        // independent - wait in parallel under one shared deadline so the total
        // pre-rollout wait is bounded by the slowest secret, not their sum.
        const deadlineMs = Date.now() + SECRET_SYNC_TIMEOUT_MS;
        const synced = await Promise.all(
            pending.map(async (entry) => {
                const secretVersion = await this.waitForSecretSynced(
                    namespace,
                    entry.esName,
                    entry.secretName,
                    syncRequestedAtMs,
                    deadlineMs,
                );
                return { appName: entry.appName, info: { secretName: entry.secretName, secretVersion } };
            }),
        );
        for (const { appName, info } of synced) {
            result.set(appName, info);
        }

        this.logger.info("AWS ExternalSecrets applied and synced", {
            appliedCount: result.size,
            requestedCount: targets.length,
            namespace,
        });

        return result;
    }

    /**
     * Deletes any target Secret that Postgres wrote, so ESO can create and own it.
     *
     * The counterpart of {@link releaseTargets}: it makes flipping
     * `PREVIEWKIT_SECRETS_READ` back to `aws` a config change rather than a
     * one-way door. ESO's `creationPolicy: Owner` will not adopt a Secret it does
     * not own, so a Postgres-written one left in place keeps the ExternalSecret out
     * of Ready until the deploy deadline.
     *
     * Narrow by design - only Secrets carrying previewkit's own `app-secret` type
     * label are touched, never an ESO-owned or foreign one. Deleting it is safe
     * here: `envFrom` is read at pod start, so running pods keep their env, and the
     * caller waits for ESO to repopulate the Secret before any rollout.
     */
    async reclaimTargets(namespace: string, secretNames: string[]): Promise<void> {
        await Promise.all(secretNames.map((secretName) => this.reclaimTarget(namespace, secretName)));
    }

    private async reclaimTarget(namespace: string, secretName: string): Promise<void> {
        try {
            const secret = await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
            if (secret.metadata?.labels?.[SECRET_LABEL.type] !== POSTGRES_SECRET_TYPE) return;

            this.logger.info("Deleting a postgres-written Secret so ESO can own it again", {
                namespace,
                extra: { secretName },
            });
            await this.coreApi.deleteNamespacedSecret({ name: secretName, namespace });
        } catch (err) {
            if (isNotFound(err)) return;
            // Left in place, the ExternalSecret cannot adopt it and the sync wait
            // below times out with a less obvious message, so say it here.
            this.logger.warn("Could not reclaim a Secret for ESO; its ExternalSecret may not go Ready", {
                namespace,
                extra: { secretName, err },
            });
        }
    }

    /**
     * Gives up ESO's ownership of these K8s Secrets, for targets another store is
     * taking over. The ExternalSecret is deleted with `Orphan` propagation, so the
     * Secret it owns survives: the default would have the garbage collector delete
     * every dependent, taking the live preview's credentials with it.
     *
     * Best-effort per target - a leftover ExternalSecret would keep reconciling the
     * Secret back from AWS every 5m, but the values agree while both stores are
     * written, so a failure here is not worth failing a deploy over.
     */
    async releaseTargets(namespace: string, secretNames: string[]): Promise<void> {
        if (secretNames.length === 0) return;

        const wanted = new Set(secretNames);
        const existing = await this.listManagedExternalSecrets(namespace).catch((err: unknown) => {
            this.logger.warn("Could not list ExternalSecrets to release; continuing", { namespace, extra: { err } });
            return [];
        });

        for (const es of existing) {
            if (!wanted.has(es.target)) continue;

            this.logger.info("Releasing an ExternalSecret's target; that Secret is now written from postgres", {
                namespace,
                extra: { esName: es.name, target: es.target },
            });
            await this.deleteExternalSecretBestEffort(namespace, es.name, "Orphan");
        }
    }

    /**
     * Delete any previewkit-managed ExternalSecret in the namespace that targets
     * an app we are deploying now (`desiredTargets`) but is not the current row's
     * ExternalSecret (`desiredEsNames`). That is a stale Owner left behind by a
     * prior generation of the same app - it still owns the target K8s Secret, so
     * the current ExternalSecret can never sync until it is removed.
     *
     * Scoped to `desiredTargets` so a per-app redeploy never touches another app's
     * secret, and so an orphan for a fully-removed app is left alone (it blocks
     * nothing). The target Secret is Retained on delete, so the current
     * ExternalSecret adopts it on the next apply. This should not happen, so it is
     * logged fatal for us to clean up the leftover row - but recovered gracefully.
     */
    private async pruneCollidingExternalSecrets(
        namespace: string,
        desiredEsNames: Set<string>,
        desiredTargets: Set<string>,
    ): Promise<void> {
        const existing = await this.listManagedExternalSecrets(namespace);
        for (const es of existing) {
            if (desiredEsNames.has(es.name)) continue;
            if (!desiredTargets.has(es.target)) continue;

            this.logger.fatal(
                "Pruning an orphaned ExternalSecret that still owns a target the current app needs - a leftover from a deleted app generation in this reused namespace",
                { namespace, extra: { esName: es.name, target: es.target } },
            );
            await this.deleteExternalSecretBestEffort(namespace, es.name);
        }
    }

    private async listManagedExternalSecrets(namespace: string): Promise<Array<{ name: string; target: string }>> {
        const list = await this.customApi.listNamespacedCustomObject({
            group: ESO_GROUP,
            version: ESO_VERSION,
            namespace,
            plural: ESO_PLURAL,
            labelSelector: `${SECRET_LABEL.managedBy}=${MANAGED_BY_PREVIEWKIT},${SECRET_LABEL.type}=${EXTERNAL_SECRET_TYPE}`,
        });
        const parsed = ExternalSecretListSchema.safeParse(list);
        if (!parsed.success) {
            this.logger.warn("Could not parse ExternalSecret list; skipping prune", {
                namespace,
                extra: { err: parsed.error.message },
            });
            return [];
        }
        const managed: Array<{ name: string; target: string }> = [];
        for (const item of parsed.data.items) {
            const name = item.metadata?.name;
            const target = item.spec?.target?.name;
            if (name != null && target != null) managed.push({ name, target });
        }
        return managed;
    }

    private async deleteExternalSecretBestEffort(
        namespace: string,
        esName: string,
        propagationPolicy: "Background" | "Orphan" = "Background",
    ): Promise<void> {
        try {
            await this.customApi.deleteNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name: esName,
                body: { propagationPolicy },
            });
            this.logger.info("Pruned orphaned ExternalSecret", { namespace, extra: { esName } });
        } catch (err) {
            if (isNotFound(err)) return;
            this.logger.warn("Failed to prune orphaned ExternalSecret; continuing with deploy", {
                namespace,
                extra: { esName, err },
            });
        }
    }

    /**
     * Poll an ExternalSecret until ESO reports a successful reconcile that
     * happened after `syncRequestedAtMs` (i.e. after our force-sync) and its
     * target K8s Secret is populated, then return that Secret's resourceVersion.
     * Bounded by the caller's shared `deadlineMs`; throws on timeout so the
     * deploy aborts before rolling out a pod that would mount a missing/stale
     * secret.
     */
    private async waitForSecretSynced(
        namespace: string,
        esName: string,
        secretName: string,
        syncRequestedAtMs: number,
        deadlineMs: number,
    ): Promise<string> {
        let lastReason = "no status yet";
        while (Date.now() < deadlineMs) {
            const sync = await this.evaluateExternalSecretSync(namespace, esName, syncRequestedAtMs);
            if (sync.ready) {
                const version = await this.readSecretResourceVersion(namespace, secretName);
                if (version != null) {
                    this.logger.info("ExternalSecret synced into K8s Secret", {
                        namespace,
                        extra: { esName, secretName, secretVersion: version },
                    });
                    return version;
                }
                lastReason = "target K8s Secret not populated yet";
            } else {
                lastReason = sync.reason;
            }
            await sleep(SECRET_SYNC_POLL_INTERVAL_MS);
        }
        // Infra failure (ESO / ClusterSecretStore / AWS), not the customer's code -
        // surface it as a platform error so the runner logs it fatal and shows a
        // generic message instead of leaking the raw ExternalSecret detail.
        throw new PreviewPlatformError(
            `ExternalSecret "${esName}" did not sync before the deploy deadline (${lastReason}); aborting before app rollout`,
        );
    }

    private async evaluateExternalSecretSync(
        namespace: string,
        esName: string,
        syncRequestedAtMs: number,
    ): Promise<{ ready: true } | { ready: false; reason: string }> {
        let obj: unknown;
        try {
            obj = await this.customApi.getNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name: esName,
            });
        } catch (err) {
            if (isNotFound(err)) return { ready: false, reason: "ExternalSecret not visible yet" };
            throw err;
        }

        const parsed = ExternalSecretStatusSchema.safeParse(obj);
        const status = parsed.success ? parsed.data.status : undefined;
        if (status == null) return { ready: false, reason: "no status yet" };

        const isReady = status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
        if (!isReady) return { ready: false, reason: "Ready condition not True" };
        if (status.refreshTime == null) return { ready: false, reason: "no refreshTime" };

        const refreshedAtMs = new Date(status.refreshTime).getTime();
        if (Number.isNaN(refreshedAtMs)) return { ready: false, reason: "unparseable refreshTime" };
        if (refreshedAtMs < syncRequestedAtMs - SECRET_SYNC_CLOCK_SKEW_MS) {
            return { ready: false, reason: "last sync predates force-sync request" };
        }
        return { ready: true };
    }

    private async readSecretResourceVersion(namespace: string, secretName: string): Promise<string | undefined> {
        try {
            const secret = await this.coreApi.readNamespacedSecret({ name: secretName, namespace });
            const data = secret.data ?? {};
            // Created-but-empty placeholder: not yet populated, keep polling.
            if (Object.keys(data).length === 0) return undefined;
            return secret.metadata?.resourceVersion ?? undefined;
        } catch (err) {
            if (isNotFound(err)) return undefined;
            throw err;
        }
    }

    private buildExternalSecret(
        record: { id: string; awsSecretArn: string },
        k8sSecretName: string,
        namespace: string,
        organizationId: string,
        forceSyncToken: string,
    ): ExternalSecret {
        return {
            apiVersion: "external-secrets.io/v1",
            kind: "ExternalSecret",
            metadata: {
                name: externalSecretName(record.id),
                namespace,
                labels: {
                    [SECRET_LABEL.managedBy]: MANAGED_BY_PREVIEWKIT,
                    [SECRET_LABEL.type]: EXTERNAL_SECRET_TYPE,
                    [SECRET_LABEL.org]: organizationId,
                },
                annotations: {
                    [FORCE_SYNC_ANNOTATION]: forceSyncToken,
                },
            },
            spec: {
                refreshInterval: "5m",
                secretStoreRef: {
                    name: this.clusterSecretStoreName,
                    kind: "ClusterSecretStore",
                },
                target: {
                    name: k8sSecretName,
                    creationPolicy: "Owner",
                },
                dataFrom: [{ extract: { key: record.awsSecretArn } }],
            },
        };
    }

    private async applyExternalSecret(namespace: string, resource: ExternalSecret): Promise<void> {
        const name = resource.metadata.name;
        try {
            await this.customApi.createNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                body: resource,
            });
        } catch (err: unknown) {
            if (!isConflict(err)) throw err;

            const existing = ExternalSecretMetadataSchema.parse(
                await this.customApi.getNamespacedCustomObject({
                    group: ESO_GROUP,
                    version: ESO_VERSION,
                    namespace,
                    plural: ESO_PLURAL,
                    name,
                }),
            );

            await this.customApi.replaceNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name,
                body: {
                    ...resource,
                    metadata: {
                        ...resource.metadata,
                        resourceVersion: existing.metadata?.resourceVersion ?? undefined,
                    },
                },
            });
        }
    }
}
