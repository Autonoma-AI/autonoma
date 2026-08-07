import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    parseSnapshotDependencyShaMap,
    type SnapshotDependencyShaMap,
    trustedPreviewConfigSchema,
} from "@autonoma/types";

/**
 * Pins the deployed dependency-SHA map onto a snapshot once and never rewrites
 * it, so a redeploy mid-run can't move the ground truth under an in-flight
 * snapshot. The `PreviewkitEnvironment` match is `headSha`-exact so an env that
 * redeployed past this commit misses rather than pinning code that never ran.
 * Keys are the lowercased `owner/repo`, because repository identity is
 * case-insensitive.
 *
 * The column also holds legacy alias-keyed maps (`{ "be": "<sha>" }`) from the
 * retired multirepo config; an alias can't be resolved to a repo, so a consumer
 * treats any key lacking a `/` (or an empty map) as "no resolvable dependencies".
 */
export class SnapshotDependencyManifestPinner {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    public async ensurePinned(snapshotId: string): Promise<void> {
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
            this.logger.info("Snapshot dependency manifest already pinned, leaving it untouched", {
                extra: {
                    dependencyCount: Object.keys(parseSnapshotDependencyShaMap(snapshot.pinnedDependencyShas)).length,
                },
            });
            return;
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
    }

    /** Degrades to an empty map (never throws) whenever the deployed manifest can't be recovered - a gap must not halt the run. */
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

    private extractDependencyShas(resolvedConfig: unknown): SnapshotDependencyShaMap {
        if (resolvedConfig == null) return {};

        // Deploy-resolved, platform-authored config, so parse with the trusted variant.
        const parsed = trustedPreviewConfigSchema.safeParse(resolvedConfig);
        if (!parsed.success) {
            this.logger.warn("Failed to parse previewkit resolvedConfig, pinning empty manifest", {
                extra: { issues: parsed.error.issues.slice(0, 5) },
            });
            return {};
        }

        const manifest: SnapshotDependencyShaMap = {};
        for (const settings of parsed.data.repositories) {
            if (settings.sha != null) manifest[settings.repo.toLowerCase()] = settings.sha;
        }
        return manifest;
    }
}
