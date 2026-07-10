import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type SecretSummary, trustedPreviewConfigSchema } from "@autonoma/types";
import type { PreviewkitSecretsService } from "./previewkit-secrets.service";

/** Health of one secret key for one app: present in the bundle and/or declared as a build secret. */
export interface SecretStatusEntry {
    key: string;
    /** A value is registered in AWS Secrets Manager for this key. */
    present: boolean;
    /** Masked length (never the value); present only when the key exists. */
    maskedLength?: number;
    /**
     * Non-reversible fingerprint (first 12 hex of SHA-256 of the value) for checking
     * whether the set value matches one you hold, without exposing it. Present only
     * when the key exists. Recompute as `sha256(value).hex.slice(0, 12)` to compare.
     */
    fingerprint?: string;
    /** The key is declared in the app's `build_secrets`, so it must be present for the build to succeed. */
    requiredAtBuild: boolean;
}

/** One topology-wired env var: a non-secret value that is a template resolved at deploy time. */
export interface ConnectionEntry {
    key: string;
    /** Template value (e.g. "{{db.url}}"); non-secret, resolved from the topology at deploy - shown as-is. */
    value: string;
    /** Also passed as a Docker build arg (needed at build time, not just runtime). */
    buildTime: boolean;
}

export interface AppSecretStatus {
    appName: string;
    /**
     * The complete env-var surface for this app, so an agent sees every variable it
     * may need to change: `connections` are topology-wired vars (non-secret template
     * values, shown as-is); `secrets` are secret-backed vars (declared build secrets
     * plus any registered runtime secrets) with presence + masked length only.
     */
    connections: ConnectionEntry[];
    secrets: SecretStatusEntry[];
    /** Declared `build_secrets` with no value registered - a concrete, actionable misconfig. */
    missingBuildSecrets: string[];
}

export interface SecretStatusResult {
    applicationId: string;
    /** False when the application has no saved preview config yet (apps is then empty). */
    configured: boolean;
    apps: AppSecretStatus[];
}

/**
 * Pure declared-vs-present diff for one app. `buildSecrets` are the keys the app
 * declares in its config `build_secrets` (required for the build); `present` are
 * the keys actually registered in the app's AWS Secrets Manager bundle (masked
 * length only). The union is returned sorted; values never appear.
 */
export function computeSecretStatus(buildSecrets: string[], present: SecretSummary[]): SecretStatusEntry[] {
    const required = new Set(buildSecrets);
    const presentByKey = new Map(present.map((secret) => [secret.key, secret]));
    const keys = new Set([...required, ...presentByKey.keys()]);

    return [...keys]
        .sort((a, b) => a.localeCompare(b))
        .map((key) => {
            const summary = presentByKey.get(key);
            return {
                key,
                present: summary != null,
                maskedLength: summary?.maskedLength,
                fingerprint: summary?.fingerprint,
                requiredAtBuild: required.has(key),
            };
        });
}

/**
 * Reports, per app of an application's active preview config, which secret keys
 * are registered (masked) and which declared build secrets are missing - without
 * ever reading a secret value. Backs the MCP `get_secret_status` tool so a
 * client's agent can see a missing env var and fix it, never the value. The
 * active config document (DB-stored, platform-authored) is the source of the
 * declared `build_secrets`; the AWS Secrets Manager bundle (via
 * {@link PreviewkitSecretsService}, masked) is the source of what is present.
 */
export class PreviewkitSecretStatusService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly secrets: PreviewkitSecretsService,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async status(applicationId: string, organizationId: string): Promise<SecretStatusResult> {
        this.logger.info("Computing secret status", { applicationId, organizationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { activeConfigRevisionId: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

        if (application.activeConfigRevisionId == null) {
            return { applicationId, configured: false, apps: [] };
        }

        const revision = await this.db.previewkitConfigRevision.findFirst({
            where: { id: application.activeConfigRevisionId, applicationId },
            select: { document: true },
        });
        const parsed = revision != null ? trustedPreviewConfigSchema.safeParse(revision.document) : undefined;
        if (parsed == null || !parsed.success) {
            return { applicationId, configured: false, apps: [] };
        }

        const apps: AppSecretStatus[] = [];
        for (const app of parsed.data.apps) {
            const present = await this.secrets.list(applicationId, app.name, organizationId);
            const secrets = computeSecretStatus(app.build_secrets, present);
            const connections = app.connections.map((connection) => ({
                key: connection.key,
                value: connection.value,
                buildTime: connection.build_time,
            }));
            apps.push({
                appName: app.name,
                connections,
                secrets,
                missingBuildSecrets: secrets.filter((s) => s.requiredAtBuild && !s.present).map((s) => s.key),
            });
        }

        this.logger.info("Secret status computed", { applicationId, extra: { appCount: apps.length } });
        return { applicationId, configured: true, apps };
    }
}
