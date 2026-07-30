import type { SecretValues } from "@autonoma/secrets";
import { describeSecretBundle, type SecretBundle } from "@autonoma/utils";
import type * as k8s from "@kubernetes/client-node";
import { isConflict, isNotFound } from "../deployer/k8s-errors";
import { PreviewPlatformError } from "../errors";
import { type Logger, logger as rootLogger } from "../logger";
import type { AppSecretInfo, RuntimeSecretMaterializer, SecretTarget } from "./runtime-secret-materializer";
import { MANAGED_BY_PREVIEWKIT, POSTGRES_SECRET_TYPE, SECRET_LABEL } from "./secret-labels";

/**
 * The K8s Secret writes this needs - `k8s.CoreV1Api` satisfies it. Narrow on
 * purpose: naming the two calls means a test can exercise the handoff and the
 * create/replace fallback without a cluster.
 */
export interface SecretWriter {
    replaceNamespacedSecret(params: { name: string; namespace: string; body: k8s.V1Secret }): Promise<k8s.V1Secret>;
    createNamespacedSecret(params: { namespace: string; body: k8s.V1Secret }): Promise<k8s.V1Secret>;
}

/**
 * Writes each app's runtime K8s Secret straight from Postgres.
 *
 * There is nothing to wait for here, which is the point: the write is the sync,
 * so the Secret is populated by the time this returns and the deployer can roll
 * out immediately. The ESO path has to force a reconcile and then poll for it,
 * and a stuck controller there costs the whole deploy.
 *
 * Apps whose bundle Postgres holds nothing for are left out of the returned map
 * rather than written empty - that means not backfilled, not "no secrets", and an
 * empty Secret would boot pods with no credentials. The caller falls those back to
 * the ESO path.
 */
export class PostgresSecretMaterializer implements RuntimeSecretMaterializer {
    private readonly logger: Logger;

    constructor(
        private readonly secrets: SecretWriter,
        private readonly values: SecretValues,
        /**
         * Releases any ExternalSecret still owning a target we are about to write.
         * Two writers on one Secret means whichever reconciles last wins, so the
         * handoff has to happen before the first Postgres write.
         */
        private readonly release: (namespace: string, secretNames: string[]) => Promise<void>,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async materialize(
        namespace: string,
        organizationId: string,
        targets: SecretTarget[],
    ): Promise<Map<string, AppSecretInfo>> {
        const result = new Map<string, AppSecretInfo>();
        if (targets.length === 0) return result;

        this.logger.info("Materializing runtime secrets from postgres", {
            namespace,
            organizationId,
            extra: { apps: targets.map((target) => target.record.appName) },
        });

        // Opening every bundle first means a namespace is never left half handed
        // over: if one bundle cannot be read, the whole set stays on ESO, where it
        // already works. Independent reads, so they go together.
        const opened = await Promise.all(targets.map((target) => this.open(target)));
        const readable: Array<{ target: SecretTarget; values: Record<string, string> }> = [];
        for (const entry of opened) {
            if (entry.values != null) readable.push({ target: entry.target, values: entry.values });
        }
        if (readable.length === 0) return result;

        await this.release(
            namespace,
            readable.map((entry) => entry.target.secretName),
        );

        // Each write is a distinct Secret name (dedupe guarantees it) with nothing
        // depending on another, so they go together rather than one round trip at a
        // time in front of the rollout.
        const written = await Promise.all(
            readable.map(async (entry) => ({
                appName: entry.target.record.appName,
                info: {
                    secretName: entry.target.secretName,
                    secretVersion: await this.write(namespace, organizationId, entry.target, entry.values),
                },
            })),
        );
        for (const { appName, info } of written) {
            result.set(appName, info);
        }

        this.logger.info("Runtime secrets materialized from postgres", {
            namespace,
            extra: { written: result.size, requested: targets.length },
        });
        return result;
    }

    private async open(target: SecretTarget): Promise<{ target: SecretTarget; values?: Record<string, string> }> {
        const bundle: SecretBundle = {
            kind: "app",
            applicationId: target.record.applicationId,
            appName: target.record.appName,
        };
        const label = describeSecretBundle(bundle);

        try {
            const values = await this.values.getAll(bundle);
            if (values == null) {
                this.logger.error("Postgres holds no values for this bundle; leaving it on External Secrets", {
                    extra: { bundle: label },
                });
                return { target };
            }
            return { target, values };
        } catch (err) {
            this.logger.error("Failed to open a secret bundle; leaving it on External Secrets", {
                extra: { bundle: label },
                err,
            });
            return { target };
        }
    }

    /** Returns the written Secret's resourceVersion, which rolls the app's pods. */
    private async write(
        namespace: string,
        organizationId: string,
        target: SecretTarget,
        values: Record<string, string>,
    ): Promise<string> {
        const secret: k8s.V1Secret = {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
                name: target.secretName,
                namespace,
                labels: {
                    [SECRET_LABEL.managedBy]: MANAGED_BY_PREVIEWKIT,
                    [SECRET_LABEL.type]: POSTGRES_SECRET_TYPE,
                    [SECRET_LABEL.org]: organizationId,
                },
                // An ESO-created Secret carries an ownerReference to its
                // ExternalSecret, and the release above orphans rather than deletes
                // it so the Secret survives. Clearing the list here rather than
                // relying on the garbage collector to strip it makes the handoff
                // independent of GC timing.
                ownerReferences: [],
            },
            type: "Opaque",
            stringData: values,
        };

        const written = await this.replaceOrCreate(namespace, target.secretName, secret);
        const version = written.metadata?.resourceVersion;
        if (version == null) {
            // Without it the pod template is unchanged and a rotated secret never
            // reaches a running pod, which is the failure this whole path exists to
            // prevent - so it fails the deploy rather than rolling out silently.
            throw new PreviewPlatformError(
                `Wrote K8s Secret "${target.secretName}" but the API returned no resourceVersion; aborting before app rollout`,
            );
        }

        this.logger.info("Wrote runtime secret from postgres", {
            namespace,
            appName: target.record.appName,
            extra: { secretName: target.secretName, keyCount: Object.keys(values).length, secretVersion: version },
        });
        return version;
    }

    /**
     * Replace wins over patch: the Secret must end up holding exactly the bundle's
     * keys, and a merge patch would leave a key deleted in Postgres still mounted
     * in the preview.
     */
    private async replaceOrCreate(namespace: string, name: string, secret: k8s.V1Secret): Promise<k8s.V1Secret> {
        try {
            return await this.secrets.replaceNamespacedSecret({ name, namespace, body: secret });
        } catch (err) {
            if (!isNotFound(err)) throw err;
        }

        try {
            return await this.secrets.createNamespacedSecret({ namespace, body: secret });
        } catch (err) {
            // Created between the two calls (ESO racing its last reconcile, or a
            // concurrent deploy). The replace is authoritative, so take it again.
            if (!isConflict(err)) throw err;
            return await this.secrets.replaceNamespacedSecret({ name, namespace, body: secret });
        }
    }
}
