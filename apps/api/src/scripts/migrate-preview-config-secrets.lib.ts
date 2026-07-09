import { logger as rootLogger } from "@autonoma/logger";
import { type Connection, SecretKeySchema, hasConnectionToken, isReservedPreviewkitEnvKey } from "@autonoma/types";
import { z } from "zod";

/**
 * Pure transform for the env/build_args -> secrets/connections migration,
 * separated from the DB/CLI orchestration so it can be unit-tested (the script
 * runs `main()` on import).
 */

const logger = rootLogger.child({ name: "migrate-preview-config-secrets" });

export const MIGRATED_SCHEMA_VERSION = 2;

const envMapSchema = z.record(z.string(), z.string());
const stringArraySchema = z.array(z.string());
const recordSchema = z.record(z.string(), z.unknown());

export const migrationDocumentSchema = z
    .object({
        apps: z.array(recordSchema).default([]),
        services: z.array(recordSchema).default([]),
    })
    .passthrough();

/**
 * Whether a document is already in the post-migration (new-model) shape: no app
 * carries the old `env`/`build_args` blocks and no service carries the old `env`
 * block, so there is nothing to convert.
 */
export function isAlreadyMigratedShape(document: z.infer<typeof migrationDocumentSchema>): boolean {
    const anyAppOldModel = document.apps.some((app) => app.env != null || app.build_args != null);
    const anyServiceOldModel = document.services.some((service) => service.env != null);
    return !anyAppOldModel && !anyServiceOldModel;
}

export interface AppMigration {
    appName: string;
    /** New document object for this app (env/build_args/replicas removed). */
    app: Record<string, unknown>;
    /** Literal values to upsert into the app's AWS secret bundle. */
    secrets: Record<string, string>;
}

/** Splits one app's env + build_args into secrets (literals) and connections (token templates). */
export function migrateApp(appRecord: Record<string, unknown>): AppMigration {
    const {
        env: rawEnv,
        build_args: rawBuildArgs,
        replicas: _replicas,
        build_secrets: rawBuildSecrets,
        connections: _connections,
        ...rest
    } = appRecord;
    const appName = typeof rest.name === "string" ? rest.name : "(unnamed)";
    const envMap = envMapSchema.optional().parse(rawEnv) ?? {};
    const buildArgs = envMapSchema.optional().parse(rawBuildArgs) ?? {};
    const existingBuildSecrets = stringArraySchema.optional().parse(rawBuildSecrets) ?? [];

    const connectionsByKey = new Map<string, Connection>();
    const secrets: Record<string, string> = {};
    const buildSecretKeys = new Set<string>(existingBuildSecrets);

    const classify = (key: string, value: string, buildTime: boolean) => {
        if (isReservedPreviewkitEnvKey(key)) return;
        if (!SecretKeySchema.safeParse(key).success) {
            logger.warn("Skipping variable with an invalid key", { appName, key });
            return;
        }
        // Any value that interpolates a {{name.property}} token is a connection
        // (resolved at deploy), including composite strings like
        // `mongodb://{{db.host}}:{{db.port}}/x` that a single target/property pair
        // could not express. Pure literals fall through to the secret bundle.
        if (hasConnectionToken(value)) {
            const existing = connectionsByKey.get(key);
            connectionsByKey.set(key, { key, value, build_time: buildTime || existing?.build_time === true });
            return;
        }
        // A literal value is a secret; keep the env value on a key that is both
        // (env is the source of truth), and record build-arg literals as build secrets.
        secrets[key] = secrets[key] ?? value;
        if (buildTime) buildSecretKeys.add(key);
    };

    for (const [key, value] of Object.entries(envMap)) classify(key, value, false);
    for (const [key, value] of Object.entries(buildArgs)) classify(key, value, true);

    const app: Record<string, unknown> = { ...rest, connections: [...connectionsByKey.values()] };
    const buildSecrets = [...buildSecretKeys].filter((key) => !connectionsByKey.has(key));
    if (buildSecrets.length > 0) app.build_secrets = buildSecrets;

    // A key that resolved to a connection (a token in either map) must not also be
    // written to AWS: the connection wins at deploy time, so the secret would be
    // an orphaned, stale value under a live key.
    const secretsWithoutConnections: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
        if (!connectionsByKey.has(key)) secretsWithoutConnections[key] = value;
    }

    return { appName, app, secrets: secretsWithoutConnections };
}

/** Moves postgres POSTGRES_USER/DB into typed options and drops the free-text service env. */
export function migrateService(serviceRecord: Record<string, unknown>): Record<string, unknown> {
    const { env: rawEnv, ...rest } = serviceRecord;
    const envMap = envMapSchema.optional().parse(rawEnv) ?? {};
    const serviceName = typeof rest.name === "string" ? rest.name : "(unnamed)";

    if (rest.recipe !== "postgres") {
        const droppedKeys = Object.keys(envMap);
        if (droppedKeys.length > 0) {
            logger.warn("Dropping non-postgres service env (service env is removed)", {
                serviceName,
                recipe: rest.recipe,
                droppedKeys,
            });
        }
        return rest;
    }

    const options = recordSchema.optional().parse(rest.options) ?? {};
    if (envMap.POSTGRES_USER != null && options.user == null) options.user = envMap.POSTGRES_USER;
    if (envMap.POSTGRES_DB != null && options.database == null) options.database = envMap.POSTGRES_DB;

    const droppedKeys = Object.keys(envMap).filter((key) => key !== "POSTGRES_USER" && key !== "POSTGRES_DB");
    if (droppedKeys.length > 0) {
        logger.warn("Dropping postgres service env keys with no typed option", { serviceName, droppedKeys });
    }
    return { ...rest, options };
}
