import { Prisma, type PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { toSlug } from "@autonoma/utils";
import matter from "gray-matter";
import { Service } from "../service";

type CreateSkillInput = {
    name: string;
    description: string;
    content: string;
    applicationId: string;
    organizationId: string;
};

type CreateBulkSkillsInput = {
    files: File[];
    applicationId: string;
    organizationId: string;
};

export class SkillsService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async createSkill(data: CreateSkillInput) {
        this.logger.info("Creating skill", { name: data.name, applicationId: data.applicationId });

        const application = await this.db.application.findFirst({
            where: { id: data.applicationId, organizationId: data.organizationId },
            select: {
                id: true,
                mainBranch: {
                    select: {
                        activeSnapshot: { select: { id: true } },
                    },
                },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const slug = toSlug(data.name);
        const activeSnapshotId = application.mainBranch?.activeSnapshot?.id;

        try {
            return await this.db.$transaction(async (tx) => {
                const skill = await tx.skill.create({
                    data: {
                        name: data.name,
                        slug,
                        description: data.description,
                        applicationId: data.applicationId,
                        organizationId: data.organizationId,
                    },
                    select: { id: true },
                });

                const skillPlan = await tx.skillPlan.create({
                    data: {
                        content: data.content,
                        skillId: skill.id,
                        organizationId: data.organizationId,
                    },
                    select: { id: true },
                });

                if (activeSnapshotId != null) {
                    await tx.skillAssignment.create({
                        data: {
                            snapshotId: activeSnapshotId,
                            skillId: skill.id,
                            planId: skillPlan.id,
                        },
                    });
                    this.logger.info("Skill assigned to active snapshot", { snapshotId: activeSnapshotId });
                }

                this.logger.info("Skill created", { skillId: skill.id, slug });

                return { id: skill.id, slug };
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError(`A skill with the name "${data.name}" already exists`);
            }
            throw error;
        }
    }

    async createBulkSkills(data: CreateBulkSkillsInput) {
        this.logger.info("Creating bulk skills", {
            fileCount: data.files.length,
            applicationId: data.applicationId,
        });

        const application = await this.db.application.findFirst({
            where: { id: data.applicationId, organizationId: data.organizationId },
            select: {
                id: true,
                mainBranch: {
                    select: {
                        activeSnapshot: { select: { id: true } },
                    },
                },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const activeSnapshotId = application.mainBranch?.activeSnapshot?.id;

        const parsedSkills = await Promise.all(
            data.files.map(async (file) => {
                const raw = await file.text();
                const { data: frontmatter, content } = matter(raw);
                const name = (frontmatter.name as string | undefined) ?? file.name.replace(/\.(md|markdown)$/i, "");
                const description = frontmatter.description as string | undefined;
                if (description == null || description.trim().length === 0) {
                    throw new BadRequestError(`Skill "${name}" is missing a description in its frontmatter`);
                }
                return { name, description, content: content.trim() };
            }),
        );

        try {
            return await this.db.$transaction(async (tx) => {
                const results: { id: string; slug: string }[] = [];

                for (const skill of parsedSkills) {
                    const slug = toSlug(skill.name);

                    const created = await tx.skill.create({
                        data: {
                            name: skill.name,
                            slug,
                            description: skill.description,
                            applicationId: data.applicationId,
                            organizationId: data.organizationId,
                        },
                        select: { id: true },
                    });

                    const skillPlan = await tx.skillPlan.create({
                        data: {
                            content: skill.content,
                            skillId: created.id,
                            organizationId: data.organizationId,
                        },
                        select: { id: true },
                    });

                    if (activeSnapshotId != null) {
                        await tx.skillAssignment.create({
                            data: {
                                snapshotId: activeSnapshotId,
                                skillId: created.id,
                                planId: skillPlan.id,
                            },
                        });
                    }

                    results.push({ id: created.id, slug });
                }

                this.logger.info("Bulk skills created", { count: results.length });

                return results;
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError("A skill with a duplicate name was found in the upload");
            }
            throw error;
        }
    }

    async listSkills(applicationId: string, organizationId: string) {
        this.logger.info("Listing skills", { applicationId });

        return this.db.skill.findMany({
            where: { applicationId, application: { organizationId } },
            select: {
                id: true,
                name: true,
                slug: true,
                description: true,
                createdAt: true,
            },
            orderBy: { name: "asc" },
        });
    }

    async getSkillBySlug(applicationId: string, slug: string, organizationId: string) {
        this.logger.info("Getting skill by slug", { applicationId, slug });

        const skill = await this.db.skill.findFirst({
            where: { slug, applicationId, application: { organizationId } },
            include: {
                plans: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { id: true, content: true, createdAt: true },
                },
            },
        });

        if (skill == null) throw new NotFoundError("Skill not found");

        const activePlan = skill.plans[0];

        return {
            id: skill.id,
            name: skill.name,
            slug: skill.slug,
            description: skill.description,
            content: activePlan?.content,
            createdAt: skill.createdAt,
            updatedAt: skill.updatedAt,
        };
    }

    async deleteSkill(applicationId: string, slug: string, organizationId: string) {
        this.logger.info("Deleting skill", { applicationId, slug });

        const skill = await this.db.skill.findFirst({
            where: { slug, applicationId, application: { organizationId } },
            select: { id: true },
        });

        if (skill == null) throw new NotFoundError("Skill not found");

        await this.db.skill.delete({ where: { id: skill.id } });

        this.logger.info("Skill deleted", { skillId: skill.id, slug });
    }
}
