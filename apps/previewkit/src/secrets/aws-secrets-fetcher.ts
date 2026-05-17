import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { logger as rootLogger, type Logger } from "../logger";

/**
 * Fetches secret values from AWS Secrets Manager and exposes a lookup helper
 * for `.preview.yaml`'s `build_secrets:` field.
 *
 * Each `PreviewkitSecret.awsSecretArn` is expected to point at an AWS SM
 * secret whose `SecretString` is a JSON object — same shape the existing
 * ExternalSecret CR bridge already assumes for runtime secrets. We just read
 * the same JSON from a different consumer (the build pipeline) so values can
 * be threaded into `BuildKitBuilder` as build-time args without ever touching
 * the repo or a K8s Secret.
 *
 * The fetcher caches per-ARN within an instance lifetime. Since one
 * `PreviewPipeline.deploy()` call instantiates one fetcher at most, that
 * effectively caches per-deployment — the same ARN isn't fetched twice within
 * a single PR's pipeline. New PRs get a fresh fetch.
 */
export class AwsSecretsFetcher {
    private readonly client: SecretsManagerClient;
    private readonly cache = new Map<string, Record<string, string>>();
    private readonly logger: Logger;

    constructor(region: string) {
        this.client = new SecretsManagerClient({ region });
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Fetches the JSON-encoded SecretString at `awsSecretArn` and returns the
     * parsed key→value map. Throws on network errors, missing SecretString, or
     * invalid JSON — the build should fail loudly rather than silently ship a
     * bundle with empty values where secrets were expected.
     */
    async fetchJson(awsSecretArn: string): Promise<Record<string, string>> {
        const cached = this.cache.get(awsSecretArn);
        if (cached != null) return cached;

        this.logger.info("Fetching AWS Secrets Manager secret", { awsSecretArn });
        const response = await this.client.send(new GetSecretValueCommand({ SecretId: awsSecretArn }));
        if (response.SecretString == null) {
            throw new Error(`AWS secret ${awsSecretArn} has no SecretString (binary secrets unsupported)`);
        }

        const parsed = JSON.parse(response.SecretString) as unknown;
        if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
            throw new Error(`AWS secret ${awsSecretArn} SecretString is not a JSON object`);
        }

        const map: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== "string") {
                throw new Error(`AWS secret ${awsSecretArn} key "${key}" is not a string`);
            }
            map[key] = value;
        }

        this.cache.set(awsSecretArn, map);
        this.logger.info("AWS secret fetched", { awsSecretArn, keyCount: Object.keys(map).length });
        return map;
    }

    /**
     * Pulls the requested keys out of an already-fetched secret map. Returns
     * a Record suitable for merging into `BuildRequest.buildArgs`. Missing
     * keys throw — a key listed in `build_secrets:` but absent from the AWS
     * secret is a config bug and we want the build to fail loudly rather than
     * produce a bundle with empty values inlined.
     */
    pickKeys(secretMap: Record<string, string>, keys: readonly string[], awsSecretArn: string): Record<string, string> {
        const result: Record<string, string> = {};
        const missing: string[] = [];
        for (const key of keys) {
            const value = secretMap[key];
            if (value == null) {
                missing.push(key);
                continue;
            }
            result[key] = value;
        }
        if (missing.length > 0) {
            throw new Error(
                `AWS secret ${awsSecretArn} is missing keys requested via build_secrets: ${missing.join(", ")}`,
            );
        }
        return result;
    }
}
