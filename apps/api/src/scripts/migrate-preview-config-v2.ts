import { createClient, Prisma, type PrismaClient } from "@autonoma/db";
import { OctokitGitHubApp, type GitHubApp } from "@autonoma/github";
import { base64PrivateKey } from "@autonoma/github/schemas";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import { migratePreviewConfigToV2 } from "./migrate-preview-config-v2.lib";

/**
 * One-time migration to preview-config document v2: folds the
 * `dependencyDocuments` sidecar into the single `document`, stamps a mandatory
 * `repository` on every app, and restructures `config.multirepo` into the
 * top-level `repositories[]` + `branch_convention`. Also rewrites every
 * `PreviewkitEnvironment.resolvedConfig` snapshot best-effort so the summary /
 * readiness / grounding readers keep parsing environments deployed before the
 * cutover. Defaults to DRY RUN - pass `--apply` to write.
 *
 *   GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... \
 *   pnpm --filter @autonoma/api exec tsx src/scripts/migrate-preview-config-v2.ts <DATABASE_URL> \
 *     [--apply] [--print] [--application <id>] [--map <applicationId>=<owner/repo> ...]
 *
 * `--print` writes each migrated document to stdout as pretty JSON (for review;
 * works with or without `--apply`).
 *
 * The connection string is passed explicitly (never read from the ambient env)
 * so this targets exactly the env DB you name - run it once per prod/beta/alpha,
 * and re-run after the API rollout finishes to catch rows written by old pods.
 *
 * The Application's repo full name resolves through, in order:
 * 1. an explicit `--map <applicationId>=<owner/repo>` override;
 * 2. the GitHub App installation listing, matched by the numeric
 *    `githubRepositoryId` (the same lookup the API's save path uses). Enabled
 *    when `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (base64 PEM - the exact
 *    values from the SAME env's API, since installation ids in this DB belong
 *    to that env's GitHub App) are set;
 * 3. the newest PreviewkitEnvironment the repo ever deployed.
 * A row none of those resolve is reported and SKIPPED; re-running is safe
 * (already-v2 rows short-circuit).
 *
 * Leaves the `dependency_documents` column in place - it is dropped, together
 * with this script, in the follow-up PR once every environment is migrated.
 */

// The environment pass pages through PreviewkitEnvironment by id: the table has
// one row per (repo, PR) ever deployed and each resolvedConfig is a full
// topology blob, so an unbounded findMany would hold every blob in memory.
const ENVIRONMENT_BATCH_SIZE = 200;

interface CliArgs {
    connectionString: string;
    apply: boolean;
    print: boolean;
    applicationId?: string;
    repoByApplicationId: Map<string, string>;
}

interface RowOutcome {
    applicationId: string;
    kind: "config" | "environment";
    id: string;
    outcome: "migrated" | "already_v2" | "skipped";
    reason?: string;
}

class PreviewConfigV2Migrator {
    private readonly logger: Logger;
    private readonly outcomes: RowOutcome[] = [];
    /**
     * The migrated (v2) config document per application from the config pass,
     * so the environment pass attributes apps to repos from what WILL be (or
     * just was) written - in a dry run the DB still holds v1 documents, which
     * would misattribute every dependency app to the primary repo.
     */
    private readonly migratedDocumentByApplication = new Map<string, Record<string, unknown>>();
    /**
     * Installation repo listings per organization (github repo id -> full
     * name), fetched at most once per org. A failed listing caches as an empty
     * map so one broken installation never hammers GitHub across its rows.
     */
    private readonly installationReposByOrg = new Map<string, Map<number, string>>();

    constructor(
        private readonly db: PrismaClient,
        private readonly args: CliArgs,
        private readonly githubApp: GitHubApp | undefined,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async run(): Promise<void> {
        await this.migrateConfigs();
        await this.migrateResolvedConfigs();
        this.report();
    }

    private async migrateConfigs(): Promise<void> {
        const rows = await this.db.previewkitConfig.findMany({
            where: this.args.applicationId != null ? { applicationId: this.args.applicationId } : {},
            select: {
                applicationId: true,
                document: true,
                dependencyDocuments: true,
                application: { select: { organizationId: true, githubRepositoryId: true } },
            },
        });
        this.logger.info("Migrating previewkit configs", { extra: { total: rows.length, apply: this.args.apply } });

        for (const row of rows) {
            // Version-probe before resolving the repo name, so a re-run over an
            // already-migrated row never demands a --map it no longer needs.
            if (isV2Document(row.document)) {
                this.record({
                    applicationId: row.applicationId,
                    kind: "config",
                    id: row.applicationId,
                    outcome: "already_v2",
                });
                continue;
            }
            const primaryRepository = await this.resolvePrimaryRepository(
                row.applicationId,
                row.application.organizationId,
                row.application.githubRepositoryId,
            );
            if (primaryRepository == null) {
                this.record({
                    applicationId: row.applicationId,
                    kind: "config",
                    id: row.applicationId,
                    outcome: "skipped",
                    reason:
                        "primary repo full name unresolvable - set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY " +
                        "or pass --map <applicationId>=<owner/repo>",
                });
                continue;
            }

            const result = migratePreviewConfigToV2({
                document: row.document,
                dependencyDocuments: row.dependencyDocuments,
                primaryRepository,
            });
            if (result.status === "already_v2") {
                this.record({
                    applicationId: row.applicationId,
                    kind: "config",
                    id: row.applicationId,
                    outcome: "already_v2",
                });
                continue;
            }
            if (result.status === "invalid") {
                this.record({
                    applicationId: row.applicationId,
                    kind: "config",
                    id: row.applicationId,
                    outcome: "skipped",
                    reason: result.reason,
                });
                continue;
            }

            this.migratedDocumentByApplication.set(row.applicationId, result.document);
            this.emitDocument(`config ${row.applicationId}`, result.document);
            if (this.args.apply) {
                await this.db.previewkitConfig.update({
                    where: { applicationId: row.applicationId },
                    data: { document: result.document },
                });
            }
            this.record({
                applicationId: row.applicationId,
                kind: "config",
                id: row.applicationId,
                outcome: "migrated",
            });
        }
    }

    /**
     * Rewrites the per-environment resolvedConfig snapshots. Apps are attributed
     * to their repository via the owning application's (already migrated) config
     * document; an app the current config no longer names is attributed to the
     * environment's own repo. Environments previewkit never resolved a config
     * for (resolvedConfig null) are untouched.
     */
    private async migrateResolvedConfigs(): Promise<void> {
        this.logger.info("Migrating environment resolvedConfig snapshots", {
            extra: { batchSize: ENVIRONMENT_BATCH_SIZE },
        });

        // Keyset pagination on id (cuids sort fine lexicographically; the order
        // just has to be stable). `gt: ""` matches every id on the first page.
        let lastId = "";
        for (;;) {
            const rows = await this.db.previewkitEnvironment.findMany({
                where: { resolvedConfig: { not: Prisma.DbNull }, id: { gt: lastId } },
                orderBy: { id: "asc" },
                take: ENVIRONMENT_BATCH_SIZE,
                select: {
                    id: true,
                    namespace: true,
                    repoFullName: true,
                    githubRepositoryId: true,
                    organizationId: true,
                    resolvedConfig: true,
                },
            });
            if (rows.length === 0) break;
            lastId = rows[rows.length - 1]!.id;

            for (const row of rows) {
                await this.migrateResolvedConfigRow(row);
            }
        }
    }

    private async migrateResolvedConfigRow(row: {
        id: string;
        namespace: string;
        repoFullName: string;
        githubRepositoryId: number | null;
        organizationId: string;
        resolvedConfig: unknown;
    }): Promise<void> {
        const applicationId = await this.resolveApplicationId(row.organizationId, row.githubRepositoryId);
        if (this.args.applicationId != null && applicationId !== this.args.applicationId) return;

        const appRepositories = applicationId != null ? await this.loadAppRepositories(applicationId) : undefined;
        const result = migratePreviewConfigToV2({
            document: row.resolvedConfig,
            primaryRepository: row.repoFullName,
            appRepositories,
        });
        const outcomeBase = {
            applicationId: applicationId ?? "unknown",
            kind: "environment" as const,
            id: row.namespace,
        };
        if (result.status === "already_v2") {
            this.record({ ...outcomeBase, outcome: "already_v2" });
            return;
        }
        if (result.status === "invalid") {
            this.record({ ...outcomeBase, outcome: "skipped", reason: result.reason });
            return;
        }

        this.emitDocument(`environment ${row.namespace}`, result.document);
        if (this.args.apply) {
            await this.db.previewkitEnvironment.update({
                where: { id: row.id },
                data: { resolvedConfig: result.document },
            });
        }
        this.record({ ...outcomeBase, outcome: "migrated" });
    }

    /**
     * The app's repo full name: an explicit --map wins, then the GitHub App
     * installation listing (matched by the numeric repo id - the API save
     * path's own lookup), then the newest environment's repoFullName.
     */
    private async resolvePrimaryRepository(
        applicationId: string,
        organizationId: string,
        githubRepositoryId: number | null,
    ): Promise<string | undefined> {
        const mapped = this.args.repoByApplicationId.get(applicationId);
        if (mapped != null) return mapped;
        if (githubRepositoryId == null) return undefined;

        const listing = await this.listInstallationRepos(organizationId);
        const fromGithub = listing.get(githubRepositoryId);
        if (fromGithub != null) return fromGithub;

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { githubRepositoryId },
            orderBy: { updatedAt: "desc" },
            select: { repoFullName: true },
        });
        return environment?.repoFullName;
    }

    /** The org installation's repos by GitHub id; empty when GitHub resolution is off or the listing fails. */
    private async listInstallationRepos(organizationId: string): Promise<Map<number, string>> {
        const cached = this.installationReposByOrg.get(organizationId);
        if (cached != null) return cached;

        const listing = new Map<number, string>();
        this.installationReposByOrg.set(organizationId, listing);
        if (this.githubApp == null) return listing;

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { installationId: true },
        });
        if (installation == null) {
            this.logger.warn("Organization has no GitHub installation; falling back to environment rows", {
                organizationId,
            });
            return listing;
        }

        try {
            const client = await this.githubApp.getInstallationClient(installation.installationId);
            for (const repo of await client.listInstallationRepos()) {
                listing.set(repo.id, repo.fullName);
            }
            this.logger.info("Listed installation repositories", {
                organizationId,
                extra: { installationId: installation.installationId, repos: listing.size },
            });
        } catch (err) {
            this.logger.warn("Failed to list installation repositories; falling back to environment rows", {
                organizationId,
                extra: { installationId: installation.installationId },
                err,
            });
        }
        return listing;
    }

    private async resolveApplicationId(
        organizationId: string,
        githubRepositoryId: number | null,
    ): Promise<string | undefined> {
        if (githubRepositoryId == null) return undefined;
        const application = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            select: { id: true },
        });
        return application?.id;
    }

    /** app name -> repository from the application's (v2) config document, for merged snapshots. */
    private async loadAppRepositories(applicationId: string): Promise<Map<string, string> | undefined> {
        let document: unknown = this.migratedDocumentByApplication.get(applicationId);
        if (document == null) {
            const config = await this.db.previewkitConfig.findUnique({
                where: { applicationId },
                select: { document: true },
            });
            document = config?.document;
        }
        if (document == null || typeof document !== "object" || Array.isArray(document)) return undefined;
        const apps = "apps" in document && Array.isArray(document.apps) ? document.apps : [];
        const map = new Map<string, string>();
        for (const app of apps) {
            if (app == null || typeof app !== "object" || Array.isArray(app)) continue;
            const name = "name" in app && typeof app.name === "string" ? app.name : undefined;
            const repository = "repository" in app && typeof app.repository === "string" ? app.repository : undefined;
            if (name != null && repository != null) map.set(name, repository);
        }
        return map;
    }

    private emitDocument(label: string, document: Record<string, unknown>): void {
        if (!this.args.print) return;
        // Deliberately raw stdout, not the structured logger: the output is the
        // document itself, for eyeballing / diffing.
        process.stdout.write(`--- ${label}${this.args.apply ? "" : " [dry-run]"} ---\n`);
        process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    }

    private record(outcome: RowOutcome): void {
        this.outcomes.push(outcome);
        if (outcome.outcome === "skipped") {
            this.logger.warn("Row skipped", {
                applicationId: outcome.applicationId,
                extra: { kind: outcome.kind, id: outcome.id, reason: outcome.reason },
            });
        }
    }

    private report(): void {
        const count = (kind: RowOutcome["kind"], outcome: RowOutcome["outcome"]) =>
            this.outcomes.filter((row) => row.kind === kind && row.outcome === outcome).length;
        this.logger.info("Migration finished", {
            extra: {
                apply: this.args.apply,
                configs: {
                    migrated: count("config", "migrated"),
                    alreadyV2: count("config", "already_v2"),
                    skipped: count("config", "skipped"),
                },
                environments: {
                    migrated: count("environment", "migrated"),
                    alreadyV2: count("environment", "already_v2"),
                    skipped: count("environment", "skipped"),
                },
            },
        });
        for (const row of this.outcomes.filter((outcome) => outcome.outcome === "skipped")) {
            this.logger.warn("Needs attention", {
                applicationId: row.applicationId,
                extra: { kind: row.kind, id: row.id, reason: row.reason },
            });
        }
    }
}

function isV2Document(document: unknown): boolean {
    return (
        document != null &&
        typeof document === "object" &&
        !Array.isArray(document) &&
        "version" in document &&
        document.version === 2
    );
}

function parseArgs(argv: string[]): CliArgs {
    const [connectionString, ...rest] = argv;
    if (connectionString == null || connectionString.startsWith("--")) {
        throw new Error(
            "Usage: tsx src/scripts/migrate-preview-config-v2.ts <DATABASE_URL> " +
                "[--apply] [--print] [--application <id>] [--map <applicationId>=<owner/repo> ...]",
        );
    }
    const args: CliArgs = {
        connectionString,
        apply: false,
        print: false,
        repoByApplicationId: new Map(),
    };
    for (let i = 0; i < rest.length; i += 1) {
        const flag = rest[i];
        if (flag === "--apply") args.apply = true;
        else if (flag === "--print") args.print = true;
        else if (flag === "--application") {
            const value = rest[i + 1];
            if (value == null) throw new Error("--application requires an id");
            args.applicationId = value;
            i += 1;
        } else if (flag === "--map") {
            const value = rest[i + 1];
            const [applicationId, repo] = value?.split("=") ?? [];
            if (applicationId == null || repo == null || !repo.includes("/")) {
                throw new Error("--map requires <applicationId>=<owner/repo>");
            }
            args.repoByApplicationId.set(applicationId, repo);
            i += 1;
        } else throw new Error(`Unknown flag: ${flag}`);
    }
    return args;
}

// Optional GitHub App credentials, validated at the process boundary. Same
// names and encoding (base64 PEM) as the API's env, so the operator exports
// that env's values verbatim. Deliberately not the API's `createEnv` module -
// importing it would demand the API's entire required env for a DB script.
const githubCredentialsSchema = z.object({
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: base64PrivateKey.optional(),
});

function buildGitHubApp(): GitHubApp | undefined {
    const logger = rootLogger.child({ name: "buildGitHubApp" });
    const credentials = githubCredentialsSchema.parse(process.env);
    if (credentials.GITHUB_APP_ID == null || credentials.GITHUB_APP_PRIVATE_KEY == null) {
        logger.info("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set - repo names resolve from environment rows only");
        return undefined;
    }
    logger.info("GitHub resolution enabled", { extra: { appId: credentials.GITHUB_APP_ID } });
    // The webhook secret and slug feed webhook verification and deep links,
    // neither of which this script's listing calls touch.
    return new OctokitGitHubApp({
        appId: credentials.GITHUB_APP_ID,
        privateKey: credentials.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: "unused-by-migration",
        appSlug: "migration",
    });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const db = createClient(args.connectionString);
    try {
        await new PreviewConfigV2Migrator(db, args, buildGitHubApp()).run();
    } finally {
        await db.$disconnect();
    }
}

void main();
