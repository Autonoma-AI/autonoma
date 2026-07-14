import { db, type PrismaClient } from "@autonoma/db";
import * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { isConflict, isNotFound } from "../deployer/k8s-errors";
import { PreviewPlatformError } from "../errors";
import { type Logger, logger as rootLogger } from "../logger";

const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_ORG = "previewkit.dev/org";

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

/**
 * What the deployer needs to wire an app to its ESO-managed secret: the K8s
 * Secret name (mounted via `envFrom`) and that Secret's resourceVersion at
 * deploy time. The version is stamped onto the app's pod template so a secret
 * change rolls the pods - `envFrom` is captured at pod start, so a running pod
 * never picks up a later secret update on its own.
 */
export interface AppSecretInfo {
    secretName: string;
    secretVersion: string;
}

const ExternalSecretStatusSchema = z.object({
    status: z
        .object({
            refreshTime: z.string().nullish(),
            conditions: z.array(z.object({ type: z.string(), status: z.string() })).nullish(),
        })
        .nullish(),
});

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

export class AwsExternalSecretManager {
    private readonly customApi: k8s.CustomObjectsApi;
    private readonly coreApi: k8s.CoreV1Api;
    private readonly logger: Logger;

    constructor(
        kc: k8s.KubeConfig,
        private readonly clusterSecretStoreName: string,
        private readonly prisma: PrismaClient = db,
    ) {
        this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Creates one ExternalSecret CR per (app, AWS-SM-ARN) pair registered for
     * this Application. Each app's secret is independently IAM-scoped — adding
     * a new app to the monorepo requires registering its own PreviewkitSecret
     * row pointing at its own AWS SM ARN.
     *
     * Returns appName → {secretName, secretVersion} for the apps that have a
     * registered secret, so the deployer can wire `envFrom` per Deployment and
     * stamp the secret version on the pod template. Apps without a registered
     * secret are simply absent from the map.
     *
     * Blocks until ESO has materialised each target K8s Secret from the current
     * AWS value (force-syncing first to skip the 5m refresh) BEFORE returning,
     * so the deployer never rolls out a pod that references a Secret ESO has not
     * populated yet (or has not refreshed after a rotation) - the root cause of
     * the deterministic "ready pod with a missing/stale AUTONOMA_SHARED_SECRET →
     * every signed SDK call 401s" failure. Throws on sync timeout so the deploy
     * fails cleanly instead.
     */
    async applyForNamespace(
        organizationId: string,
        githubRepositoryId: number,
        namespace: string,
        appNames: string[],
    ): Promise<Map<string, AppSecretInfo>> {
        this.logger.info("Applying AWS ExternalSecrets for namespace", {
            organizationId,
            githubRepositoryId,
            namespace,
            appNames,
        });

        // Scope to THIS deploy's Application, identified by (organizationId,
        // githubRepositoryId) - not the whole org. App names are unique within an
        // application's topology but NOT across an org: a bare `appName IN (...)`
        // match collides when two applications each own an app of the same name
        // (e.g. "web"), which would apply a foreign application's secret into this
        // namespace and its ExternalSecret would never go Ready. Dependency-repo
        // apps ride the primary app's config, so their secrets live
        // under this same Application.
        const records = await this.prisma.previewkitSecret.findMany({
            where: {
                application: { organizationId, githubRepositoryId },
                appName: { in: appNames },
            },
        });

        const result = new Map<string, AppSecretInfo>();

        if (records.length === 0) {
            this.logger.info("No AWS ExternalSecrets registered for any of the listed apps", {
                namespace,
                appNames,
            });
            return result;
        }

        // Stamp one force-sync token for the batch and remember when we asked,
        // so the readiness wait can require a reconcile that happened after it.
        const syncRequestedAtMs = Date.now();
        const forceSyncToken = new Date(syncRequestedAtMs).toISOString();
        const pending: Array<{ appName: string; esName: string; secretName: string }> = [];

        for (const record of records) {
            // K8s Secret name is derived from appName locally — see toK8sName().
            // The previewkit_secret row no longer persists it.
            const k8sSecretName = this.toK8sName(record.appName);
            const resource = this.buildExternalSecret(record, k8sSecretName, namespace, organizationId, forceSyncToken);
            await this.applyExternalSecret(namespace, resource);
            pending.push({ appName: record.appName, esName: resource.metadata.name, secretName: k8sSecretName });

            this.logger.info("Applied AWS ExternalSecret", {
                appName: record.appName,
                k8sSecretName,
                awsSecretArn: record.awsSecretArn,
                namespace,
                extra: { esName: resource.metadata.name },
            });
        }

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
            requestedCount: appNames.length,
            namespace,
        });

        return result;
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
            await delay(SECRET_SYNC_POLL_INTERVAL_MS);
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
                name: `previewkit-aws-${record.id}`,
                namespace,
                labels: {
                    [LABEL_MANAGED_BY]: "previewkit",
                    [LABEL_TYPE]: "aws-external-secret",
                    [LABEL_ORG]: organizationId,
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

    /**
     * Derive the K8s Secret name that External Secrets Operator materialises
     * in the preview namespace from the inner app's name. The per-PR namespace
     * already provides isolation, so `<appName>-secrets` is unique without any
     * further scoping. Mirrors the rules `previewkit.dev/managed-by` k8s names
     * follow: lowercase alnum + hyphens, trimmed, capped under the 63-char
     * label limit (55 + `-secrets` suffix = 63).
     */
    private toK8sName(appName: string): string {
        return appName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 55)
            .concat("-secrets");
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

            const existing = (await this.customApi.getNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name,
            })) as { metadata?: { resourceVersion?: string } };

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
                        resourceVersion: existing.metadata?.resourceVersion,
                    },
                },
            });
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
