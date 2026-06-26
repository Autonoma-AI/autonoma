import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    parseSnapshotDependencyShaMap,
    type SnapshotDependencyShaMap,
    trustedPreviewConfigSchema,
} from "@autonoma/types";

/**
 * Pins the per-dependency deployed-commit map onto a snapshot the first time
 * grounding runs for it.
 *
 * The map is resolved from the `headSha`-exact `PreviewkitEnvironment` match
 * (keyed by `githubRepositoryId`, `prNumber`, `headSha`) and read from that
 * environment's enriched `resolvedConfig`. `headSha`-exact is deliberate: if the
 * environment already redeployed past this snapshot's commit, the lookup misses
 * rather than pinning code that never ran for this snapshot.
 *
 * Pinning is idempotent and runs exactly once per snapshot: once the column is
 * non-null, every later agent (both reviewers, every healing iteration) reads
 * that pinned copy, so a redeploy can not corrupt an in-flight snapshot's
 * multi-repo fidelity. A missing/partial manifest (failed deploy, redeploy race,
 * repo not deployed, previewkit not involved) pins an empty/partial map - never
 * an error.
 */
export class SnapshotDependencyManifestPinner {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Ensures the snapshot's dependency manifest is pinned and returns the pinned
     * map. Resolves and writes the pin on first call; returns the already-pinned
     * copy unchanged on every subsequent call.
     */
    public async ensurePinned(snapshotId: string): Promise<SnapshotDependencyShaMap> {
        this.logger.info("Ensuring snapshot dependency manifest is pinned");

        const snapshot = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: {
                headSha: true,
                pinnedDependencyShas: true,
                branch: {
                    select: {
                        prInfo: { select: { prNumber: true } },
                        application: { select: { githubRepositoryId: true } },
                    },
                },
            },
        });

        if (snapshot.pinnedDependencyShas != null) {
            const existing = parseSnapshotDependencyShaMap(snapshot.pinnedDependencyShas);
            this.logger.info("Snapshot dependency manifest already pinned, leaving it untouched", {
                extra: { dependencyCount: Object.keys(existing).length },
            });
            return existing;
        }

        const manifest = await this.resolveManifest(
            snapshot.headSha,
            snapshot.branch.prInfo?.prNumber,
            snapshot.branch.application.githubRepositoryId,
        );

        await this.db.branchSnapshot.update({
            where: { id: snapshotId },
            data: { pinnedDependencyShas: manifest },
        });
        this.logger.info("Pinned snapshot dependency manifest", {
            extra: { dependencyCount: Object.keys(manifest).length },
        });
        return manifest;
    }

    /**
     * Resolves the per-dependency SHA map for the snapshot, degrading to an empty
     * map whenever the deployed manifest can not be recovered. Never throws: a
     * fidelity gap lowers what the agent can see, it does not halt the review.
     */
    private async resolveManifest(
        headSha: string | null,
        prNumber: number | undefined,
        githubRepositoryId: number | null,
    ): Promise<SnapshotDependencyShaMap> {
        if (headSha == null || prNumber == null || githubRepositoryId == null) {
            this.logger.info("Snapshot is not a deployable PR snapshot, pinning empty manifest", {
                extra: {
                    hasHeadSha: headSha != null,
                    hasPrNumber: prNumber != null,
                    hasGithubRepositoryId: githubRepositoryId != null,
                },
            });
            return {};
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { githubRepositoryId, prNumber, headSha },
            select: { id: true, resolvedConfig: true },
        });
        if (environment == null) {
            this.logger.info("No headSha-exact previewkit environment, pinning empty manifest", {
                extra: { githubRepositoryId },
            });
            return {};
        }

        const manifest = this.extractDependencyShas(environment.resolvedConfig);
        this.logger.info("Resolved dependency manifest from previewkit environment", {
            extra: { environmentId: environment.id, dependencyCount: Object.keys(manifest).length },
        });
        return manifest;
    }

    /**
     * Projects the per-dependency SHA map from an environment's enriched
     * `resolvedConfig`. Only dependencies that recorded a `sha` at deploy time are
     * pinned; a config that fails to parse or carries no multirepo block yields an
     * empty map (partial manifest -> partial pin).
     */
    private extractDependencyShas(resolvedConfig: unknown): SnapshotDependencyShaMap {
        if (resolvedConfig == null) return {};

        // `resolvedConfig` is the deploy-resolved, platform-authored config, so it
        // re-parses with the trusted variant (per the previewkit-config contract).
        const parsed = trustedPreviewConfigSchema.safeParse(resolvedConfig);
        if (!parsed.success) {
            this.logger.warn("Failed to parse previewkit resolvedConfig, pinning empty manifest", {
                extra: { issues: parsed.error.issues.slice(0, 5) },
            });
            return {};
        }

        const repos = parsed.data.config?.multirepo?.repos ?? [];
        const manifest: SnapshotDependencyShaMap = {};
        for (const repo of repos) {
            if (repo.sha != null) manifest[repo.name] = repo.sha;
        }
        return manifest;
    }
}
