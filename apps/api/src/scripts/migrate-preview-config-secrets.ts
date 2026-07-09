import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { env } from "../env";
import { PreviewkitSecretsService } from "../previewkit/previewkit-secrets.service";
import {
    MIGRATED_SCHEMA_VERSION,
    isAlreadyMigratedShape,
    migrateApp,
    migrateService,
    migrationDocumentSchema,
} from "./migrate-preview-config-secrets.lib";

/**
 * One-time migration for the env/build_args -> secrets/connections cut.
 *
 * For every preview config revision still in use (each Application's active
 * revision PLUS every revision pinned by a live PreviewkitEnvironment),
 * it rewrites the stored `document` in place:
 *   - app `env` / `build_args` literals -> the app's AWS Secrets Manager bundle
 *     (overwrite if the key exists, insert otherwise);
 *   - app `env` / `build_args` values with `{{name.property}}` tokens -> `connections`
 *     (build-arg tokens get `build_time: true`); composite templates are preserved verbatim;
 *   - literal `build_args` keys join `build_secrets` (they are secrets injected
 *     at build time); existing `build_secrets` are preserved;
 *   - `replicas` and the free-text service `env` are dropped (postgres
 *     POSTGRES_USER / POSTGRES_DB move to typed `options.user` / `options.database`).
 *
 * The transform lives in `./migrate-preview-config-secrets.lib` (unit-tested);
 * this file is the DB/CLI orchestration. Dry-run by default; pass `--apply` to
 * write to AWS + the DB.
 *
 * Run: pnpm --filter @autonoma/api migrate:preview-config-secrets [-- --apply]
 */

const logger = rootLogger.child({ name: "migrate-preview-config-secrets" });

/**
 * The revision ids still in use - each app's active revision PLUS every
 * live-environment pin - ordered so ACTIVE revisions are processed LAST.
 *
 * Several in-use revisions of one app can carry different values for the same
 * secret key, and AWS `mergeIntoSecret` is last-writer-wins.
 */
async function inUseRevisionIds(): Promise<string[]> {
    const [apps, environments] = await Promise.all([
        db.application.findMany({
            where: { activeConfigRevisionId: { not: null } },
            select: { activeConfigRevisionId: true },
        }),
        db.previewkitEnvironment.findMany({
            where: { status: { not: "torn_down" }, configRevisionId: { not: null } },
            select: { configRevisionId: true },
        }),
    ]);
    const activeIds = new Set<string>();
    for (const app of apps) if (app.activeConfigRevisionId != null) activeIds.add(app.activeConfigRevisionId);
    const pinnedOnlyIds = new Set<string>();
    for (const environment of environments) {
        const id = environment.configRevisionId;
        if (id != null && !activeIds.has(id)) pinnedOnlyIds.add(id);
    }
    return [...pinnedOnlyIds, ...activeIds];
}

async function main(): Promise<void> {
    // `--db-only` rewrites the config documents in the DB but SKIPS the AWS secret writes.
    const dbOnly = process.argv.includes("--db-only");
    const apply = process.argv.includes("--apply") || dbOnly;
    const writeAws = apply && !dbOnly;
    logger.info(
        dbOnly
            ? "Running migration (DB-ONLY, no AWS)"
            : apply
              ? "Running migration (APPLY)"
              : "Running migration (dry-run)",
    );
    if (dbOnly)
        logger.warn("DB-ONLY: rewriting documents without writing secret values to AWS - for local inspection only");

    const secretsService = writeAws ? new PreviewkitSecretsService(requireAwsRegion()) : undefined;

    const revisionIds = await inUseRevisionIds();
    logger.info("Revisions in scope", { count: revisionIds.length });

    let migrated = 0;
    let skipped = 0;
    let secretsWritten = 0;

    for (const revisionId of revisionIds) {
        const revision = await db.previewkitConfigRevision.findUnique({ where: { id: revisionId } });
        if (revision == null) continue;
        if (revision.schemaVersion >= MIGRATED_SCHEMA_VERSION) {
            skipped += 1;
            continue;
        }

        const document = migrationDocumentSchema.parse(revision.document);

        if (isAlreadyMigratedShape(document)) {
            logger.info("Skipping revision already in new-model shape (no env/build_args)", {
                revisionId,
                applicationId: revision.applicationId,
            });
            skipped += 1;
            continue;
        }

        const appMigrations = document.apps.map(migrateApp);
        const nextDocument: Record<string, unknown> = {
            ...document,
            apps: appMigrations.map((migration) => migration.app),
            services: document.services.map(migrateService),
        };

        const appsWithSecrets = appMigrations.filter((migration) => Object.keys(migration.secrets).length > 0);
        logger.info("Migrating revision", {
            revisionId,
            applicationId: revision.applicationId,
            apps: appMigrations.length,
            secretApps: appsWithSecrets.map((migration) => migration.appName),
        });

        if (!apply) {
            migrated += 1;
            continue;
        }

        if (writeAws) {
            for (const migration of appsWithSecrets) {
                const items = Object.entries(migration.secrets).map(([key, value]) => ({ key, value }));
                await secretsService!.upsert(revision.applicationId, migration.appName, items, undefined);
                secretsWritten += items.length;
            }
        }

        await db.previewkitConfigRevision.update({
            where: { id: revision.id },
            data: { document: nextDocument, schemaVersion: MIGRATED_SCHEMA_VERSION },
        });
        migrated += 1;
    }

    logger.info("Migration complete", { migrated, skipped, secretsWritten, apply });
}

function requireAwsRegion(): string {
    if (env.AWS_REGION == null || env.AWS_REGION === "") {
        throw new Error("AWS_REGION must be set to write secrets (run without --apply for a dry-run).");
    }
    return env.AWS_REGION;
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        logger.error("Migration failed", err);
        process.exit(1);
    });
