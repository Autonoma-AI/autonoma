import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const DEFAULT_REGION = "us-east-1";

/**
 * Reads a repo's preview-deployment secret (the previewkit secret) via the AWS SDK - was the `aws` CLI.
 * The client is injected so it can be mocked in tests; use `PreviewSecrets.create()` for the default.
 */
export class PreviewSecrets {
    constructor(private readonly secretsClient: SecretsManagerClient) {}

    static create(region: string = DEFAULT_REGION): PreviewSecrets {
        return new PreviewSecrets(new SecretsManagerClient({ region }));
    }

    /**
     * The env-var NAMES configured in a repo's preview deployment (presence/absence only). A missing
     * third-party SDK key means that SDK never initializes in preview, so anything it gates falls back to
     * its code default - which diagnoses config/flag gaps without exposing secret values.
     */
    async getEnvVarNames(repoFullName: string): Promise<string[]> {
        return Object.keys(await this.fetchSecret(repoFullName));
    }

    /**
     * The full env-var VALUES of a repo's preview deployment - the same credentials the preview app runs
     * with, so the run-script harness can query the SAME live backend the test exercised. Read-only use.
     */
    async getEnvValues(repoFullName: string): Promise<Record<string, string>> {
        return this.fetchSecret(repoFullName);
    }

    private async fetchSecret(repoFullName: string): Promise<Record<string, string>> {
        const secretId = `previewkit/${repoFullName.toLowerCase()}/web`;
        const response = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
        return JSON.parse(response.SecretString ?? "{}");
    }
}
