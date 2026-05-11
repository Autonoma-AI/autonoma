import { db, GitHubInstallationStatus, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger, type Logger } from "../logger";

export class UnknownRepositoryError extends Error {
    constructor(repoFullName: string) {
        super(`No active GitHub installation found for repository "${repoFullName}"`);
        this.name = "UnknownRepositoryError";
    }
}

export class AmbiguousRepositoryError extends Error {
    constructor(repoFullName: string, count: number) {
        super(`Repository "${repoFullName}" matches ${count} active installations; cannot determine tenant`);
        this.name = "AmbiguousRepositoryError";
    }
}

export class OrganizationResolver {
    private readonly logger: Logger;

    constructor(private readonly prisma: PrismaClient = db) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async resolveByRepoFullName(repoFullName: string): Promise<string> {
        this.logger.info("Resolving organization for repository", { repoFullName });

        const matches = await this.prisma.gitHubRepository.findMany({
            where: {
                fullName: repoFullName,
                installation: { status: GitHubInstallationStatus.active },
            },
            select: { installation: { select: { organizationId: true } } },
        });

        if (matches.length === 0) {
            this.logger.warn("No active installation found for repository", { repoFullName });
            throw new UnknownRepositoryError(repoFullName);
        }

        const organizationIds = new Set(matches.map((m) => m.installation.organizationId));
        if (organizationIds.size > 1) {
            this.logger.error("Repository matches multiple organizations", {
                repoFullName,
                count: organizationIds.size,
            });
            throw new AmbiguousRepositoryError(repoFullName, organizationIds.size);
        }

        const organizationId = organizationIds.values().next().value;
        if (organizationId == null) {
            throw new UnknownRepositoryError(repoFullName);
        }

        this.logger.info("Resolved organization", { repoFullName, organizationId });
        return organizationId;
    }
}
