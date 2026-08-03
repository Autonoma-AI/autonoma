import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

/**
 * The default analysis-trigger label used when a repo has no {@link ApplicationTriggerConfig} row.
 */
export const DEFAULT_ANALYSIS_TRIGGER_LABEL = "autonoma:analyze";

/** The per-repo activation trigger config the webhook triggers read. */
export interface ActivationTriggerConfig {
    /** Whether marking a PR ready-for-review automatically starts an analysis run. */
    autoRunOnReadyForReview: boolean;
    /** The PR label whose addition starts an analysis run. */
    analysisTriggerLabel: string;
}

/** The repo an activation trigger fires for, resolved to its application via (org, repo id). */
export interface RepoConfigRef {
    organizationId: string;
    githubRepositoryId: number;
}

/** The persisted trigger-config columns, or `null`/`undefined` when the application has no config row. */
type TriggerConfigRow = { autoRunOnReadyForReview: boolean; analysisTriggerLabel: string } | null | undefined;

/**
 * Apply the code defaults to a (possibly missing) trigger-config row.
 */
export function resolveActivationTriggerConfig(row: TriggerConfigRow): ActivationTriggerConfig {
    return {
        autoRunOnReadyForReview: row?.autoRunOnReadyForReview ?? false,
        analysisTriggerLabel: row?.analysisTriggerLabel ?? DEFAULT_ANALYSIS_TRIGGER_LABEL,
    };
}

/**
 * Resolve a repo's activation trigger config from its linked application. Returns the code defaults when the
 * application has no config row (the common case) or no application is linked - a missing row means "unconfigured",
 * never an error.
 */
export async function readActivationTriggerConfig(
    db: PrismaClient,
    ref: RepoConfigRef,
): Promise<ActivationTriggerConfig> {
    const logger = rootLogger.child({ name: "readActivationTriggerConfig" });
    logger.info("Reading activation trigger config", {
        organizationId: ref.organizationId,
        extra: { githubRepositoryId: ref.githubRepositoryId },
    });

    const application = await db.application.findFirst({
        where: { organizationId: ref.organizationId, githubRepositoryId: ref.githubRepositoryId },
        select: {
            triggerConfig: { select: { autoRunOnReadyForReview: true, analysisTriggerLabel: true } },
        },
    });

    const config = application?.triggerConfig;
    const resolved = resolveActivationTriggerConfig(config);
    logger.info("Resolved activation trigger config", {
        organizationId: ref.organizationId,
        extra: {
            githubRepositoryId: ref.githubRepositoryId,
            hasRow: config != null,
            autoRunOnReadyForReview: resolved.autoRunOnReadyForReview,
            analysisTriggerLabel: resolved.analysisTriggerLabel,
        },
    });
    return resolved;
}
