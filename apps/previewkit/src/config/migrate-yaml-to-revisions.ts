import { db, PreviewkitConfigSource } from "@autonoma/db";
import yaml from "js-yaml";
import type { GitProvider } from "../git-provider/git-provider";
import { logger as rootLogger } from "../logger";
import { CURRENT_CONFIG_SCHEMA_VERSION, resolveConfig } from "./resolver";

const CONFIG_FILES = [".preview.yaml", ".preview.yml"];

export interface MigrateYamlOptions {
    /** Resolves repositories and fetches files via the GitHub App installation. */
    provider: GitProvider;
    /** Validate and report what would change without writing to the DB. */
    dryRun: boolean;
    /** Re-import even for Applications that already have an active config revision. */
    force: boolean;
}

export interface MigrateYamlResult {
    total: number;
    migrated: number;
    skippedActive: number;
    skippedNoInstallation: number;
    skippedNoConfig: number;
    failed: number;
}

/**
 * One-off migration that seeds the DB-backed config model from existing
 * `.preview.yaml` files. For every Application linked to a GitHub repo, it reads
 * the repo's `.preview.yaml` at the main-branch head, validates it, creates a
 * `PreviewkitConfigRevision` (source `imported_yaml`), and points the
 * Application's `activeConfigRevisionId` at it.
 *
 * Idempotent: Applications that already have an active revision are skipped unless
 * `force`. With `dryRun`, configs are validated and counted but nothing is written.
 * Per-application failures are logged and tallied without aborting the whole run.
 */
export async function migrateYamlConfigsToDb(options: MigrateYamlOptions): Promise<MigrateYamlResult> {
    const logger = rootLogger.child({ name: "migrateYamlConfigsToDb" });
    const { provider, dryRun, force } = options;

    const applications = await db.application.findMany({
        where: { githubRepositoryId: { not: null } },
        select: {
            id: true,
            organizationId: true,
            githubRepositoryId: true,
            activeConfigRevisionId: true,
            mainBranch: { select: { name: true } },
            mainBranchInfo: { select: { githubRef: true } },
        },
    });

    logger.info("Scanning applications for .preview.yaml import", { total: applications.length, dryRun, force });

    const result: MigrateYamlResult = {
        total: applications.length,
        migrated: 0,
        skippedActive: 0,
        skippedNoInstallation: 0,
        skippedNoConfig: 0,
        failed: 0,
    };

    for (const application of applications) {
        const { id: applicationId, organizationId, githubRepositoryId } = application;
        if (githubRepositoryId == null) continue;

        if (application.activeConfigRevisionId != null && !force) {
            result.skippedActive++;
            logger.info("Skipping: already has an active config revision", { applicationId });
            continue;
        }

        try {
            const installation = await db.gitHubInstallation.findUnique({
                where: { organizationId },
                select: { installationId: true, status: true },
            });
            if (installation == null || installation.status !== "active") {
                result.skippedNoInstallation++;
                logger.warn("Skipping: organization has no active GitHub installation", {
                    applicationId,
                    organizationId,
                });
                continue;
            }

            const repo = await provider.getRepository(installation.installationId, githubRepositoryId);
            const ref = normalizeBranchName(
                application.mainBranchInfo?.githubRef ?? application.mainBranch?.name ?? repo.defaultBranch,
            );

            const raw = await fetchConfigFile(provider, repo.fullName, ref);
            if (raw == null) {
                result.skippedNoConfig++;
                logger.info("Skipping: no .preview.yaml found in repo", { applicationId, repo: repo.fullName, ref });
                continue;
            }

            const document = yaml.load(raw);
            // Validate + normalize against the runtime pipeline; throws on an invalid
            // document so the per-app catch records it as a failure. We store the
            // RESOLVED config (not the raw file): a `.preview.yaml`'s `resources:`
            // block has always been ignored (standard tier), and resolving it bakes
            // that in. Storing the raw file instead would let the import silently
            // activate resource sizing the file path never applied, since revisions
            // honor `resources`. Only resources authored directly into a revision take
            // effect.
            const resolved = resolveConfig({ document });

            if (dryRun) {
                result.migrated++;
                logger.info("[dry-run] Would import .preview.yaml as the active config revision", {
                    applicationId,
                    repo: repo.fullName,
                    ref,
                });
                continue;
            }

            const revisionId = await importRevision(applicationId, resolved);
            result.migrated++;
            logger.info("Imported .preview.yaml as the active config revision", {
                applicationId,
                repo: repo.fullName,
                ref,
                revisionId,
            });
        } catch (err) {
            result.failed++;
            logger.error("Failed to migrate application config", err, { applicationId });
        }
    }

    logger.info("Migration finished", {
        dryRun,
        total: result.total,
        migrated: result.migrated,
        skippedActive: result.skippedActive,
        skippedNoInstallation: result.skippedNoInstallation,
        skippedNoConfig: result.skippedNoConfig,
        failed: result.failed,
    });
    return result;
}

/** Creates the next config revision for an Application and activates it, atomically. */
async function importRevision(applicationId: string, document: object): Promise<string> {
    return db.$transaction(async (tx) => {
        const last = await tx.previewkitConfigRevision.findFirst({
            where: { applicationId },
            orderBy: { revision: "desc" },
            select: { revision: true },
        });
        const revision = (last?.revision ?? 0) + 1;

        const created = await tx.previewkitConfigRevision.create({
            data: {
                applicationId,
                revision,
                schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
                source: PreviewkitConfigSource.imported_yaml,
                document,
                createdBy: "yaml-migration",
            },
            select: { id: true },
        });

        await tx.application.update({
            where: { id: applicationId },
            data: { activeConfigRevisionId: created.id },
        });

        return created.id;
    });
}

/** Tries `.preview.yaml` then `.preview.yml`; returns the raw contents or undefined. */
async function fetchConfigFile(provider: GitProvider, repoFullName: string, ref: string): Promise<string | undefined> {
    for (const candidate of CONFIG_FILES) {
        const raw = await provider.fetchFileContent(repoFullName, candidate, ref);
        if (raw != null) return raw;
    }
    return undefined;
}

function normalizeBranchName(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
