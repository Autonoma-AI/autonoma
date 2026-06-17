import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";

export interface PreviewkitEnvironmentStatus {
    repoFullName: string;
    prNumber: number;
    status: string;
    phase: string | undefined;
    createdAt: Date;
    updatedAt: Date;
    lastDeployedSha: string;
    urls: Record<string, string>;
    error: string | undefined;
}

/** The `previewkit_environment` columns the status response is built from. */
interface EnvironmentRow {
    status: string;
    phase: string | null;
    error: string | null;
    urls: unknown;
    headSha: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Reads preview-environment status straight from the database. Previewkit's own
 * status route read live Kubernetes namespace annotations; the pipeline already
 * mirrors that state into `previewkit_environment` (the admin dashboard reads it
 * the same way), so the API serves status natively from the DB - no Kubernetes
 * client and no forwarding needed.
 */
export class PreviewkitEnvironmentsService {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Status for one (repo, PR) preview environment, or undefined if none exists.
     * Org-scopes user callers so one org cannot read another org's status / URLs /
     * errors: a foreign environment is indistinguishable from "not found". Service
     * callers (callerOrgId == null) are trusted and not narrowed.
     */
    async getStatus(
        repoFullName: string,
        prNumber: number,
        callerOrgId: string | undefined,
    ): Promise<PreviewkitEnvironmentStatus | undefined> {
        this.logger.info("Reading previewkit environment status", { repoFullName, prNumber });

        const row = await this.db.previewkitEnvironment.findFirst({
            where:
                callerOrgId != null
                    ? { repoFullName, prNumber, organizationId: callerOrgId }
                    : { repoFullName, prNumber },
            select: {
                status: true,
                phase: true,
                error: true,
                urls: true,
                headSha: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (row == null) return undefined;
        return toEnvironmentStatus(repoFullName, prNumber, row);
    }

    /**
     * Resolve the Loki label key (`namespace`) + current `status` for one
     * environment's live log stream, applying the same org-scoping as
     * `getStatus`. Returns undefined when no such environment exists (or it
     * belongs to another org), which the SSE route maps to a 404.
     */
    async resolveStreamTarget(
        repoFullName: string,
        prNumber: number,
        callerOrgId: string | undefined,
    ): Promise<PreviewkitStreamTarget | undefined> {
        const row = await this.db.previewkitEnvironment.findFirst({
            where:
                callerOrgId != null
                    ? { repoFullName, prNumber, organizationId: callerOrgId }
                    : { repoFullName, prNumber },
            select: { namespace: true, status: true },
        });

        if (row == null) return undefined;
        return { namespace: row.namespace, status: row.status };
    }
}

/** Identifies which Loki stream to relay and whether the build has already finished. */
export interface PreviewkitStreamTarget {
    namespace: string;
    status: string;
}

/** Maps a `previewkit_environment` row to the public status shape. Pure; unit-tested. */
export function toEnvironmentStatus(
    repoFullName: string,
    prNumber: number,
    row: EnvironmentRow,
): PreviewkitEnvironmentStatus {
    return {
        repoFullName,
        prNumber,
        status: row.status,
        phase: row.phase ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastDeployedSha: row.headSha,
        urls: parseStringRecord(row.urls),
        error: row.error ?? undefined,
    };
}

/** Coerce a Prisma Json value into a flat Record<string,string>, dropping non-string values. */
function parseStringRecord(value: unknown): Record<string, string> {
    if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
        if (typeof val === "string") out[key] = val;
    }
    return out;
}
