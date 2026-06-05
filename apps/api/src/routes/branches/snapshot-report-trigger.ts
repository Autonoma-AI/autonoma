import type { Logger } from "@autonoma/logger";
import type { SnapshotReportTrigger } from "@autonoma/types";
import type { GitHubInstallationService } from "../../github/github-installation.service";

const MAX_FILES_CHANGED = 50;

export async function buildTriggerBlock({
    snapshot,
    github,
    organizationId,
    logger,
}: {
    snapshot: {
        source: string;
        headSha: string | null;
        baseSha: string | null;
        createdAt: Date;
        branch: { applicationId: string };
    };
    github: GitHubInstallationService;
    organizationId: string;
    logger: Logger;
}): Promise<SnapshotReportTrigger> {
    const headSha = snapshot.headSha ?? undefined;
    const baseSha = snapshot.baseSha ?? undefined;

    if (snapshot.headSha == null) {
        return emptyTrigger({ snapshot, headSha, baseSha });
    }

    try {
        const commit = await github.getApplicationCommit(
            organizationId,
            snapshot.branch.applicationId,
            snapshot.headSha,
        );
        return {
            headSha,
            baseSha,
            source: snapshot.source,
            createdAt: snapshot.createdAt,
            commit: { message: commit.message, authorLogin: commit.authorLogin },
            filesChanged: commit.files.slice(0, MAX_FILES_CHANGED),
            filesChangedTruncated: commit.files.length > MAX_FILES_CHANGED,
        };
    } catch (error) {
        logger.warn("Could not load commit metadata for snapshot report", {
            headSha: snapshot.headSha,
            applicationId: snapshot.branch.applicationId,
            error,
        });
        return emptyTrigger({ snapshot, headSha, baseSha });
    }
}

function emptyTrigger({
    snapshot,
    headSha,
    baseSha,
}: {
    snapshot: { source: string; createdAt: Date };
    headSha?: string;
    baseSha?: string;
}): SnapshotReportTrigger {
    return {
        headSha,
        baseSha,
        source: snapshot.source,
        createdAt: snapshot.createdAt,
        filesChanged: [],
        filesChangedTruncated: false,
    };
}
