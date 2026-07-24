import { createClient, type PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { AuthoredBuild, PreviewConfig } from "@autonoma/types";
import {
    type DependencyDocument,
    parseStoredDependencyDocuments,
    upsertConfig,
} from "../routes/onboarding/previewkit-config-helpers";
import { type BuildDecisions, migratePreviewConfigBuild } from "./migrate-preview-config-build.lib";

/**
 * Client migration: rewrite every stored PreviewKit config onto an explicit
 * `build` block so no client depends on `turbo-monorepo.ts` or railpack. Defaults
 * to DRY RUN - pass `--apply` to write.
 *
 *   pnpm --filter @autonoma/api exec tsx src/scripts/migrate-preview-config-build.ts <DATABASE_URL> [--apply] [--print] [--application <id>]
 *
 * `--print` writes each migrated document to stdout as pretty JSON (for review;
 * works with or without `--apply`).
 *
 * The connection string is passed explicitly (never read from the ambient env)
 * so this targets exactly the env DB you name - run it once per prod/beta/alpha.
 *
 * The bare-`dockerfile` bucket migrates automatically. The turbo and railpack
 * buckets need a framework choice, supplied per app in {@link DECISIONS}; a config
 * with an app in those buckets and no decision is reported and SKIPPED (never
 * guessed, never half-written). Fill {@link DECISIONS}, then re-run.
 */

// Per-app build decisions for the turbo/railpack buckets, keyed by applicationId
// then by the app's `name` (unique across a config's merged primary + dependency
// topology). Empty because every decision entered so far has been applied - a
// migrated app lands in the `has_build` bucket and is skipped on a re-run.
//
// An `AuthoredBuild` is either `runtime` or `dockerfile`: the framework presets
// are retired, so a decision cannot reintroduce a build the config editor and the
// MCP `apply_config` tools would refuse to save.
const DECISIONS: Record<string, Record<string, AuthoredBuild>> = {};

interface CliArgs {
    connectionString: string;
    apply: boolean;
    print: boolean;
    applicationId?: string;
}

interface ConfigMigrationSummary {
    applicationId: string;
    label: string;
    changed: boolean;
    wrote: boolean;
    unresolved: string[];
    validationError?: string;
}

class PreviewConfigBuildMigrator {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly apply: boolean,
        private readonly print: boolean,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    public async run(applicationId?: string): Promise<void> {
        this.logger.info("Starting preview-config build migration", { apply: this.apply, applicationId });

        const rows = await this.db.previewkitConfig.findMany({
            where: applicationId != null ? { applicationId } : undefined,
            include: { application: { select: { name: true, organization: { select: { slug: true } } } } },
        });
        this.logger.info("Loaded preview configs", { count: rows.length });

        const summaries: ConfigMigrationSummary[] = [];
        for (const row of rows) {
            summaries.push(await this.migrateConfig(row));
        }

        this.report(summaries);
    }

    private async migrateConfig(row: {
        applicationId: string;
        document: unknown;
        dependencyDocuments: unknown;
        application: { name: string; organization: { slug: string } };
    }): Promise<ConfigMigrationSummary> {
        const label = `${row.application.organization.slug}/${row.application.name}`;
        const decisions: BuildDecisions = new Map(Object.entries(DECISIONS[row.applicationId] ?? {}));

        const primary = migratePreviewConfigBuild(row.document, decisions);
        for (const migration of primary.migrations) {
            this.logger.info("app build migration", { extra: { label, source: "primary", ...migration } });
        }

        const { documents: storedDependencies, invalid } = parseStoredDependencyDocuments(row.dependencyDocuments);
        if (invalid) {
            this.logger.warn("Stored dependency documents no longer validate - skipping config", { extra: { label } });
            return { applicationId: row.applicationId, label, changed: false, wrote: false, unresolved: [] };
        }

        const migratedDependencies: DependencyDocument[] = [];
        let dependenciesChanged = false;
        const dependencyUnresolved: string[] = [];
        let dependencyError: string | undefined;
        for (const dependency of storedDependencies) {
            const result = migratePreviewConfigBuild(dependency.document, decisions);
            for (const migration of result.migrations) {
                this.logger.info("app build migration", { extra: { label, source: dependency.repo, ...migration } });
            }
            dependencyUnresolved.push(...result.unresolved);
            dependencyError = dependencyError ?? result.validationError;
            if (result.changed) dependenciesChanged = true;
            if (result.document != null) {
                migratedDependencies.push({ repo: dependency.repo, document: result.document });
            }
        }

        const unresolved = [...primary.unresolved, ...dependencyUnresolved];
        const validationError = primary.validationError ?? dependencyError;
        const changed = primary.changed || dependenciesChanged;

        if (unresolved.length > 0 || validationError != null || primary.document == null) {
            if (unresolved.length > 0) {
                this.logger.warn("Config has apps needing a framework decision - add them to DECISIONS and re-run", {
                    extra: { label, applicationId: row.applicationId, unresolved },
                });
            }
            if (validationError != null) {
                this.logger.error("Migrated config failed validation - skipping", {
                    extra: { label, validationError },
                });
            }
            return { applicationId: row.applicationId, label, changed, wrote: false, unresolved, validationError };
        }

        if (this.print) {
            this.emitDocument(label, "primary", primary.document);
            for (const dependency of migratedDependencies) {
                this.emitDocument(label, dependency.repo, dependency.document);
            }
        }

        if (!changed) {
            return { applicationId: row.applicationId, label, changed: false, wrote: false, unresolved: [] };
        }

        if (!this.apply) {
            this.logger.info("[dry-run] would write migrated config", { extra: { label } });
            return { applicationId: row.applicationId, label, changed: true, wrote: false, unresolved: [] };
        }

        await upsertConfig(this.db, row.applicationId, primary.document, migratedDependencies);
        this.logger.info("Wrote migrated config", { extra: { label } });
        return { applicationId: row.applicationId, label, changed: true, wrote: true, unresolved: [] };
    }

    /**
     * Writes a migrated document to stdout as pretty JSON (the script's data
     * output, kept off the structured logger so it stays copy-pasteable). Only
     * runs under `--print`, for review before/without applying.
     */
    private emitDocument(label: string, source: string, document: PreviewConfig): void {
        process.stdout.write(`\n===== migrated document: ${label} (${source}) =====\n`);
        process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    }

    private report(summaries: ConfigMigrationSummary[]): void {
        const changed = summaries.filter((s) => s.changed);
        const wrote = summaries.filter((s) => s.wrote);
        const blocked = summaries.filter((s) => s.unresolved.length > 0 || s.validationError != null);

        this.logger.info("Migration summary", {
            extra: {
                apply: this.apply,
                totalConfigs: summaries.length,
                changed: changed.length,
                wrote: wrote.length,
                blocked: blocked.length,
            },
        });
        for (const summary of blocked) {
            this.logger.warn("Blocked config (needs decision or invalid)", {
                extra: {
                    label: summary.label,
                    applicationId: summary.applicationId,
                    unresolved: summary.unresolved,
                    validationError: summary.validationError,
                },
            });
        }
    }
}

function parseArgs(argv: string[]): CliArgs {
    const positional = argv.filter((arg) => !arg.startsWith("--"));
    const connectionString = positional[0];
    if (connectionString == null || connectionString.trim() === "") {
        throw new Error(
            "Usage: tsx src/scripts/migrate-preview-config-build.ts <DATABASE_URL> [--apply] [--print] [--application <id>]",
        );
    }
    const applicationIndex = argv.indexOf("--application");
    const applicationId = applicationIndex >= 0 ? argv[applicationIndex + 1] : undefined;
    return { connectionString, apply: argv.includes("--apply"), print: argv.includes("--print"), applicationId };
}

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "migrate-preview-config-build" });
    const args = parseArgs(process.argv.slice(2));
    const db = createClient(args.connectionString);
    try {
        await new PreviewConfigBuildMigrator(db, args.apply, args.print).run(args.applicationId);
    } finally {
        await db.$disconnect();
    }
    logger.info("Done");
}

main().catch((err) => {
    rootLogger.child({ name: "migrate-preview-config-build" }).error("Migration failed", { extra: { err } });
    process.exitCode = 1;
});
