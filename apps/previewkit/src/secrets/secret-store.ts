import * as k8s from "@kubernetes/client-node";
import { isConflict, isNotFound } from "../deployer/k8s-errors";
import { logger } from "../logger";

const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_OWNER = "previewkit.dev/owner";
const LABEL_APP = "previewkit.dev/app";
const LABEL_PR = "previewkit.dev/pr-number";

/**
 * Stores client secrets as Kubernetes Secrets in the previewkit namespace.
 *
 * Two scopes are supported:
 *   - Owner + app (baseline, shared across all PRs for that app)
 *       previewkit-secrets-{owner}-{app}
 *   - Owner + app + PR (overrides baseline for a single preview)
 *       previewkit-secrets-{owner}-{app}-pr-{N}
 *
 * PR-scoped secrets exist so external per-preview resources (e.g. a Neon
 * database branch created by the client's CI) can be wired into a single
 * preview without leaking to other PRs. They are merged on top of the
 * baseline at deploy time and deleted with the namespace on teardown.
 */
export class SecretStore {
    private coreApi: k8s.CoreV1Api;

    constructor(
        kc: k8s.KubeConfig,
        private namespace: string = "previewkit",
    ) {
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    }

    async get(owner: string, app: string, pr?: number): Promise<Record<string, string>> {
        const name = this.secretName(owner, app, pr);
        try {
            const secret = await this.coreApi.readNamespacedSecret({
                name,
                namespace: this.namespace,
            });
            return this.decodeData(secret.data);
        } catch (err: unknown) {
            if (isNotFound(err)) return {};
            throw err;
        }
    }

    async getMerged(owner: string, app: string, pr: number): Promise<Record<string, string>> {
        const base = await this.get(owner, app);
        const prScoped = await this.get(owner, app, pr);
        return { ...base, ...prScoped };
    }

    async set(owner: string, app: string, key: string, value: string, pr?: number): Promise<void> {
        const secrets = await this.get(owner, app, pr);
        secrets[key] = value;
        await this.save(owner, app, secrets, pr);
        logger.info("Secret saved", { owner, app, key, pr });
    }

    async delete(owner: string, app: string, key: string, pr?: number): Promise<boolean> {
        const secrets = await this.get(owner, app, pr);
        if (!(key in secrets)) return false;
        delete secrets[key];
        await this.save(owner, app, secrets, pr);
        logger.info("Secret deleted", { owner, app, key, pr });
        return true;
    }

    async list(owner: string, app: string, pr?: number): Promise<string[]> {
        const secrets = await this.get(owner, app, pr);
        return Object.keys(secrets);
    }

    async deleteAllForPr(owner: string, pr: number): Promise<void> {
        const labelSelector = [
            `${LABEL_MANAGED_BY}=previewkit`,
            `${LABEL_TYPE}=client-secrets-pr`,
            `${LABEL_OWNER}=${this.sanitize(owner)}`,
            `${LABEL_PR}=${pr}`,
        ].join(",");

        const res = await this.coreApi.listNamespacedSecret({
            namespace: this.namespace,
            labelSelector,
        });

        for (const secret of res.items) {
            const name = secret.metadata?.name;
            if (!name) continue;
            try {
                await this.coreApi.deleteNamespacedSecret({ name, namespace: this.namespace });
                logger.info("PR-scoped secret deleted", { owner, pr, name });
            } catch (err: unknown) {
                if (isNotFound(err)) continue;
                throw err;
            }
        }
    }

    private async save(owner: string, app: string, secrets: Record<string, string>, pr?: number): Promise<void> {
        const name = this.secretName(owner, app, pr);
        const encodedData = this.encodeData(secrets);

        const labels: Record<string, string> = {
            [LABEL_MANAGED_BY]: "previewkit",
            [LABEL_TYPE]: pr != null ? "client-secrets-pr" : "client-secrets",
            [LABEL_OWNER]: this.sanitize(owner),
            [LABEL_APP]: this.sanitize(app),
        };
        if (pr != null) labels[LABEL_PR] = String(pr);

        const secret: k8s.V1Secret = {
            apiVersion: "v1",
            kind: "Secret",
            metadata: {
                name,
                namespace: this.namespace,
                labels,
            },
            type: "Opaque",
            data: encodedData,
        };

        try {
            await this.coreApi.createNamespacedSecret({
                namespace: this.namespace,
                body: secret,
            });
        } catch (err: unknown) {
            if (isConflict(err)) {
                await this.coreApi.replaceNamespacedSecret({
                    name,
                    namespace: this.namespace,
                    body: secret,
                });
            } else {
                throw err;
            }
        }
    }

    private secretName(owner: string, app: string, pr?: number): string {
        const base = `previewkit-secrets-${this.sanitize(owner)}-${this.sanitize(app)}`;
        return pr != null ? `${base}-pr-${pr}` : base;
    }

    private sanitize(value: string): string {
        return value.replace(/[^a-z0-9-]/g, "-").toLowerCase();
    }

    private encodeData(secrets: Record<string, string>): Record<string, string> {
        const encoded: Record<string, string> = {};
        for (const [key, value] of Object.entries(secrets)) {
            encoded[key] = Buffer.from(value).toString("base64");
        }
        return encoded;
    }

    private decodeData(data: Record<string, string> | undefined): Record<string, string> {
        if (!data) return {};
        const decoded: Record<string, string> = {};
        for (const [key, value] of Object.entries(data)) {
            decoded[key] = Buffer.from(value, "base64").toString("utf-8");
        }
        return decoded;
    }
}
