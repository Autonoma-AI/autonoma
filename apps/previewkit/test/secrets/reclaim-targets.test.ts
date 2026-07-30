import { ApiException, type V1Secret } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
    AwsExternalSecretManager,
    type ExternalSecretApi,
    type SecretApi,
} from "../../src/secrets/aws-external-secret-manager";
import { POSTGRES_SECRET_TYPE } from "../../src/secrets/secret-labels";

const NAMESPACE = "preview-acme-widgets-pr-42";

/** Stands in for the K8s Secret API, recording deletes. */
class FakeSecrets implements SecretApi {
    readonly deleted: string[] = [];

    constructor(private readonly secrets: Record<string, V1Secret>) {}

    async readNamespacedSecret(params: { name: string; namespace: string }): Promise<V1Secret> {
        const secret = this.secrets[params.name];
        if (secret == null) throw new ApiException<string>(404, "secrets not found", "", {});
        return secret;
    }

    async deleteNamespacedSecret(params: { name: string; namespace: string }): Promise<unknown> {
        this.deleted.push(params.name);
        return {};
    }
}

function secret(labels: Record<string, string>): V1Secret {
    return { metadata: { name: "web-secrets", labels } };
}

/** Reclaiming is a Secret-only operation, so every ExternalSecret call is a bug. */
class UnusedExternalSecrets implements ExternalSecretApi {
    async createNamespacedCustomObject(): Promise<unknown> {
        throw new Error("reclaimTargets must not create an ExternalSecret");
    }
    async replaceNamespacedCustomObject(): Promise<unknown> {
        throw new Error("reclaimTargets must not replace an ExternalSecret");
    }
    async getNamespacedCustomObject(): Promise<unknown> {
        throw new Error("reclaimTargets must not read an ExternalSecret");
    }
    async deleteNamespacedCustomObject(): Promise<unknown> {
        throw new Error("reclaimTargets must not delete an ExternalSecret");
    }
    async listNamespacedCustomObject(): Promise<unknown> {
        throw new Error("reclaimTargets must not list ExternalSecrets");
    }
}

function manager(secrets: SecretApi): AwsExternalSecretManager {
    return new AwsExternalSecretManager(new UnusedExternalSecrets(), secrets, "aws-secretsmanager");
}

/**
 * Reclaiming is what makes PREVIEWKIT_SECRETS_READ reversible for the runtime
 * Secret: ESO will not adopt a target it does not own, so a Postgres-written one
 * left in place keeps its ExternalSecret out of Ready until the deploy deadline.
 */
describe("AwsExternalSecretManager.reclaimTargets", () => {
    it("deletes a Secret that Postgres wrote so ESO can own it again", async () => {
        const secrets = new FakeSecrets({
            "web-secrets": secret({ "previewkit.dev/type": POSTGRES_SECRET_TYPE }),
        });

        await manager(secrets).reclaimTargets(NAMESPACE, ["web-secrets"]);

        expect(secrets.deleted).toEqual(["web-secrets"]);
    });

    it("leaves an ESO-owned Secret alone", async () => {
        // ESO stamps its own labels, never previewkit's type.
        const secrets = new FakeSecrets({
            "web-secrets": secret({ "reconcile.external-secrets.io/managed": "true" }),
        });

        await manager(secrets).reclaimTargets(NAMESPACE, ["web-secrets"]);

        expect(secrets.deleted).toEqual([]);
    });

    it("leaves an unlabelled Secret alone", async () => {
        const secrets = new FakeSecrets({ "web-secrets": { metadata: { name: "web-secrets" } } });

        await manager(secrets).reclaimTargets(NAMESPACE, ["web-secrets"]);

        expect(secrets.deleted).toEqual([]);
    });

    it("is a no-op for a target that does not exist yet", async () => {
        const secrets = new FakeSecrets({});

        await expect(manager(secrets).reclaimTargets(NAMESPACE, ["web-secrets"])).resolves.toBeUndefined();
        expect(secrets.deleted).toEqual([]);
    });
});
