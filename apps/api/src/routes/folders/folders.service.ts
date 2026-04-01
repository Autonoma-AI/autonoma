import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { Service } from "../service";

export class FoldersService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async list(applicationId: string, organizationId: string) {
        this.logger.info("Listing folders", { applicationId, organizationId });

        return this.db.folder.findMany({
            where: { applicationId, application: { organizationId } },
            select: { id: true, name: true, description: true, parentId: true },
            orderBy: { name: "asc" },
        });
    }

    async getFolderDetail(folderId: string, organizationId: string) {
        this.logger.info("Getting folder detail", { folderId });

        const folder = await this.db.folder.findFirst({
            where: { id: folderId, application: { organizationId } },
            include: {
                _count: { select: { testCases: true, children: true } },
                application: { select: { id: true, name: true } },
                parent: { select: { id: true, name: true } },
            },
        });

        if (folder == null) throw new NotFoundError("Folder not found");

        return {
            id: folder.id,
            name: folder.name,
            description: folder.description ?? undefined,
            applicationId: folder.application.id,
            parentFolderName: folder.parent?.name ?? undefined,
            parentFolderId: folder.parent?.id ?? undefined,
            testCount: folder._count.testCases,
            subfolderCount: folder._count.children,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
        };
    }

    async createFolder(
        data: { name: string; applicationId: string; parentId?: string; description?: string },
        organizationId: string,
    ) {
        this.logger.info("Creating folder", { name: data.name, applicationId: data.applicationId });

        const application = await this.db.application.findFirst({
            where: { id: data.applicationId, organizationId },
            select: { id: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

        if (data.parentId != null) {
            const parent = await this.db.folder.findFirst({
                where: { id: data.parentId, applicationId: data.applicationId },
                select: { id: true },
            });
            if (parent == null) throw new NotFoundError("Parent folder not found");
        }

        const folder = await this.db.folder.create({
            data: {
                name: data.name,
                description: data.description,
                applicationId: data.applicationId,
                organizationId,
                parentId: data.parentId,
            },
            select: { id: true },
        });

        this.logger.info("Folder created", { folderId: folder.id });

        return folder;
    }

    async renameFolder(folderId: string, name: string, organizationId: string) {
        this.logger.info("Renaming folder", { folderId, name });

        const { count } = await this.db.folder.updateMany({
            where: { id: folderId, application: { organizationId } },
            data: { name },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Folder renamed", { folderId });
    }

    async moveFolder(folderId: string, newParentId: string | null, organizationId: string) {
        this.logger.info("Moving folder", { folderId, newParentId });

        const folder = await this.db.folder.findFirst({
            where: { id: folderId, application: { organizationId } },
            select: { id: true, applicationId: true },
        });
        if (folder == null) throw new NotFoundError();

        if (newParentId != null) {
            if (newParentId === folderId) {
                throw new BadRequestError("Cannot move folder into itself");
            }

            const target = await this.db.folder.findFirst({
                where: { id: newParentId, applicationId: folder.applicationId },
                select: { id: true },
            });
            if (target == null) throw new NotFoundError("Target folder not found");

            const isDescendant = await this.isDescendantOf(newParentId, folderId);
            if (isDescendant) {
                throw new BadRequestError("Cannot move folder into its own subtree");
            }
        }

        await this.db.folder.update({
            where: { id: folderId },
            data: { parentId: newParentId },
        });

        this.logger.info("Folder moved", { folderId, newParentId });
    }

    async deleteFolder(folderId: string, organizationId: string) {
        this.logger.info("Deleting folder", { folderId });

        const { count } = await this.db.folder.deleteMany({
            where: { id: folderId, application: { organizationId } },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Folder deleted", { folderId });
    }

    async updateFolderDescription(folderId: string, description: string, organizationId: string) {
        this.logger.info("Updating folder description", { folderId });

        const { count } = await this.db.folder.updateMany({
            where: { id: folderId, application: { organizationId } },
            data: { description },
        });

        if (count === 0) throw new NotFoundError();

        this.logger.info("Folder description updated", { folderId });
    }

    private async isDescendantOf(candidateId: string, ancestorId: string): Promise<boolean> {
        let currentId: string | null = candidateId;
        const visited = new Set<string>();

        while (currentId != null) {
            if (currentId === ancestorId) return true;
            if (visited.has(currentId)) return false;
            visited.add(currentId);

            const folder: { parentId: string | null } | null = await this.db.folder.findUnique({
                where: { id: currentId },
                select: { parentId: true },
            });
            currentId = folder?.parentId ?? null;
        }

        return false;
    }
}
