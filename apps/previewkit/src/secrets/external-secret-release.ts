import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import { isNotFound } from "../deployer/k8s-errors";
import { type Logger, logger as rootLogger } from "../logger";
import { EXTERNAL_SECRET_TYPE, MANAGED_BY_PREVIEWKIT, SECRET_LABEL } from "./secret-labels";

const ESO_GROUP = "external-secrets.io";
const ESO_VERSION = "v1";
const ESO_PLURAL = "externalsecrets";

const ExternalSecretListSchema = z.object({
    items: z.array(
        z.object({
            metadata: z.object({ name: z.string().nullish() }).nullish(),
            spec: z.object({ target: z.object({ name: z.string().nullish() }).nullish() }).nullish(),
        }),
    ),
});

interface CustomObjectRef {
    group: string;
    version: string;
    namespace: string;
    plural: string;
}

/** The ExternalSecret calls this needs; `k8s.CustomObjectsApi` satisfies it. */
export interface ExternalSecretApi {
    listNamespacedCustomObject(params: CustomObjectRef & { labelSelector?: string }): Promise<unknown>;
    deleteNamespacedCustomObject(
        params: CustomObjectRef & { name: string; body?: k8s.V1DeleteOptions },
    ): Promise<unknown>;
}

/**
 * Takes a preview's K8s Secret out of External Secrets' hands, so previewkit can
 * write it from the database instead.
 *
 * This is all that remains of the ESO path, and it is decommissioning rather than
 * deploy logic: previewkit no longer creates an ExternalSecret for anything. What
 * it still has to do is release the ones created before the cutover, because an
 * ESO-managed Secret is *owned* by its ExternalSecret and would otherwise keep
 * being reconciled from a Secrets Manager copy nothing writes any more.
 *
 * It stays until every live preview namespace has been through a deploy (or the
 * sweep in `deployment/previewkit/cluster/release-external-secrets.sh`), after
 * which nothing owns those Secrets but us and this can go too.
 */
export class ExternalSecretRelease {
    private readonly logger: Logger;

    constructor(private readonly customApi: ExternalSecretApi) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Deletes the ExternalSecret owning each of `secretNames`, with `Orphan`
     * propagation so the Secret it owns survives - the default cascade would have
     * the garbage collector delete every dependent, taking a live preview's
     * credentials with it.
     *
     * Best-effort per target. A leftover ExternalSecret means ESO keeps reconciling
     * that Secret from a store nobody writes, which the next deploy will fix; losing
     * a deploy over it would be the worse trade.
     */
    async releaseTargets(namespace: string, secretNames: string[]): Promise<void> {
        if (secretNames.length === 0) return;

        const wanted = new Set(secretNames);
        const existing = await this.listManaged(namespace).catch((err: unknown) => {
            this.logger.warn("Could not list ExternalSecrets to release; continuing", { namespace, extra: { err } });
            return [];
        });

        for (const externalSecret of existing) {
            if (!wanted.has(externalSecret.target)) continue;

            this.logger.info("Releasing an ExternalSecret's target; that Secret is now written from postgres", {
                namespace,
                extra: { esName: externalSecret.name, target: externalSecret.target },
            });
            await this.deleteOrphaning(namespace, externalSecret.name);
        }
    }

    private async listManaged(namespace: string): Promise<Array<{ name: string; target: string }>> {
        const list = await this.customApi.listNamespacedCustomObject({
            group: ESO_GROUP,
            version: ESO_VERSION,
            namespace,
            plural: ESO_PLURAL,
            labelSelector: `${SECRET_LABEL.managedBy}=${MANAGED_BY_PREVIEWKIT},${SECRET_LABEL.type}=${EXTERNAL_SECRET_TYPE}`,
        });

        const parsed = ExternalSecretListSchema.safeParse(list);
        if (!parsed.success) {
            this.logger.warn("Could not parse the ExternalSecret list; releasing nothing", {
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

    private async deleteOrphaning(namespace: string, esName: string): Promise<void> {
        try {
            await this.customApi.deleteNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name: esName,
                body: { propagationPolicy: "Orphan" },
            });
            this.logger.info("Released ExternalSecret", { namespace, extra: { esName } });
        } catch (err) {
            if (isNotFound(err)) return;
            this.logger.warn("Failed to release an ExternalSecret; continuing with the deploy", {
                namespace,
                extra: { esName, err },
            });
        }
    }
}
