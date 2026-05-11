import * as k8s from "@kubernetes/client-node";
import { logger } from "../logger";
import { isConflict, isNotFound } from "./k8s-errors";

const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_PR_NUMBER = "previewkit.dev/pr-number";
const LABEL_REPO = "previewkit.dev/repo";
const LABEL_ORGANIZATION = "previewkit.dev/organization";

export { LABEL_MANAGED_BY, LABEL_ORGANIZATION, LABEL_PR_NUMBER, LABEL_REPO };

const ANN_COMMENT_ID = "previewkit.dev/comment-id";
const ANN_LAST_SHA = "previewkit.dev/last-deployed-sha";
const ANN_CREATED_AT = "previewkit.dev/created-at";
const ANN_STATUS = "previewkit.dev/status";
const ANN_PHASE = "previewkit.dev/phase";
const ANN_UPDATED_AT = "previewkit.dev/updated-at";
const ANN_ERROR = "previewkit.dev/error";
const ANN_URLS = "previewkit.dev/urls";

export type DeploymentStatus = "pending" | "building" | "deploying" | "ready" | "failed";

export interface NamespaceAnnotations {
    commentId?: string;
    lastDeployedSha?: string;
    createdAt?: string;
    status?: DeploymentStatus;
    phase?: string;
    updatedAt?: string;
    error?: string;
    urls?: Record<string, string>;
}

export class NamespaceManager {
    private coreApi: k8s.CoreV1Api;

    constructor(kc: k8s.KubeConfig) {
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    }

    buildNamespaceName(repoFullName: string, prNumber: number): string {
        const sanitized = repoFullName.replace(/[^a-z0-9-]/g, "-").toLowerCase();
        const name = `preview-${sanitized}-pr-${prNumber}`;
        return name.slice(0, 63).replace(/-+$/, "");
    }

    async create(
        repoFullName: string,
        prNumber: number,
        organizationId: string,
        annotations?: NamespaceAnnotations,
    ): Promise<string> {
        const name = this.buildNamespaceName(repoFullName, prNumber);
        const sanitizedRepo = repoFullName.replace(/\//g, "-");

        const ns: k8s.V1Namespace = {
            metadata: {
                name,
                labels: {
                    [LABEL_MANAGED_BY]: "previewkit",
                    [LABEL_ORGANIZATION]: organizationId,
                    [LABEL_PR_NUMBER]: String(prNumber),
                    [LABEL_REPO]: sanitizedRepo,
                },
                annotations: this.buildAnnotations(annotations),
            },
        };

        try {
            await this.coreApi.createNamespace({ body: ns });
            logger.info("Created namespace", { namespace: name });
        } catch (err: unknown) {
            if (isConflict(err)) {
                logger.info("Namespace already exists, updating", { namespace: name });
                await this.updateAnnotations(name, annotations);
            } else {
                throw err;
            }
        }

        return name;
    }

    async updateAnnotations(namespace: string, annotations?: NamespaceAnnotations): Promise<void> {
        if (!annotations) return;

        const existing = await this.coreApi.readNamespace({ name: namespace });
        const merged = {
            ...existing.metadata?.annotations,
            ...this.buildAnnotations(annotations, { preserveCreatedAt: true }),
        };
        existing.metadata = { ...existing.metadata, annotations: merged };
        await this.coreApi.replaceNamespace({ name: namespace, body: existing });
    }

    async getAnnotations(namespace: string): Promise<NamespaceAnnotations | undefined> {
        try {
            const res = await this.coreApi.readNamespace({ name: namespace });
            const a = res.metadata?.annotations ?? {};
            return {
                commentId: a[ANN_COMMENT_ID],
                lastDeployedSha: a[ANN_LAST_SHA],
                createdAt: a[ANN_CREATED_AT],
                status: a[ANN_STATUS] as DeploymentStatus | undefined,
                phase: a[ANN_PHASE],
                updatedAt: a[ANN_UPDATED_AT],
                error: a[ANN_ERROR],
                urls: a[ANN_URLS] ? (JSON.parse(a[ANN_URLS]) as Record<string, string>) : undefined,
            };
        } catch {
            return undefined;
        }
    }

    async delete(namespace: string): Promise<void> {
        try {
            await this.coreApi.deleteNamespace({ name: namespace });
            logger.info("Deleted namespace", { namespace });
        } catch (err: unknown) {
            if (isNotFound(err)) {
                logger.info("Namespace already deleted", { namespace });
            } else {
                throw err;
            }
        }
    }

    async exists(namespace: string): Promise<boolean> {
        try {
            await this.coreApi.readNamespace({ name: namespace });
            return true;
        } catch {
            return false;
        }
    }

    private buildAnnotations(
        annotations?: NamespaceAnnotations,
        opts?: { preserveCreatedAt?: boolean },
    ): Record<string, string> {
        const result: Record<string, string> = {};
        if (!opts?.preserveCreatedAt) {
            result[ANN_CREATED_AT] = annotations?.createdAt ?? new Date().toISOString();
        } else if (annotations?.createdAt) {
            result[ANN_CREATED_AT] = annotations.createdAt;
        }
        result[ANN_UPDATED_AT] = new Date().toISOString();
        if (annotations?.commentId) result[ANN_COMMENT_ID] = annotations.commentId;
        if (annotations?.lastDeployedSha) result[ANN_LAST_SHA] = annotations.lastDeployedSha;
        if (annotations?.status) result[ANN_STATUS] = annotations.status;
        if (annotations?.phase) result[ANN_PHASE] = annotations.phase;
        if (annotations?.error) result[ANN_ERROR] = annotations.error;
        if (annotations?.urls) result[ANN_URLS] = JSON.stringify(annotations.urls);
        return result;
    }
}
