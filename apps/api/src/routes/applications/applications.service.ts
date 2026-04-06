import type { Application, PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, Prisma, SnapshotStatus, TriggerSource } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import { toSlug } from "@autonoma/utils";
import { Service } from "../service";

const deploymentInclude = {
    mainBranch: {
        select: {
            name: true,
            deployment: {
                include: {
                    webDeployment: true,
                    mobileDeployment: true,
                },
            },
        },
    },
} as const;

type WebSpecificData = {
    architecture: typeof ApplicationArchitecture.WEB;
    url: string;
    file: string;
};

type MobileSpecificData = {
    architecture: typeof ApplicationArchitecture.IOS | typeof ApplicationArchitecture.ANDROID;
    packageUrl: string;
    packageName: string;
    photo: string;
};

type CreateApplicationFormDataInput = {
    metadata: {
        name: string;
        architecture: ApplicationArchitecture;
        url?: string;
        file?: string;
        packageUrl?: string;
        packageName?: string;
        photo?: string;
    };
    organizationId: string;
};

type CreateApplicationInput = Pick<Application, "name" | "organizationId"> & (WebSpecificData | MobileSpecificData);

type UpdateDataInput = Partial<Pick<Application, "name">> &
    (
        | (Partial<WebSpecificData> & {
              architecture: typeof ApplicationArchitecture.WEB;
          })
        | (Partial<MobileSpecificData> & {
              architecture: typeof ApplicationArchitecture.IOS | typeof ApplicationArchitecture.ANDROID;
          })
    );

type UpdateSettingsInput = Pick<Application, "customInstructions">;

export class ApplicationsService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async listApplications(organizationId: string) {
        this.logger.info("Listing applications", { organizationId });

        const apps = await this.db.application.findMany({
            where: { organizationId },
            include: deploymentInclude,
        });

        type OnboardingRow = { application_id: string; step: string };
        const onboardingStates: OnboardingRow[] =
            apps.length > 0
                ? await this.db.$queryRaw<OnboardingRow[]>`
                          SELECT application_id, step FROM onboarding_state
                          WHERE application_id IN (${Prisma.join(apps.map((a) => a.id))})
                      `.catch(() => [])
                : [];

        const stateByAppId = new Map(onboardingStates.map((s) => [s.application_id, { step: s.step }]));

        return apps.map((app) => ({
            ...app,
            onboardingState: stateByAppId.get(app.id) ?? null,
        }));
    }

    async createApplicationFromFormData(data: CreateApplicationFormDataInput) {
        const { metadata, organizationId } = data;

        if (metadata.architecture === ApplicationArchitecture.WEB) {
            return this.createApplication({
                name: metadata.name,
                organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: metadata.url ?? "",
                file: metadata.file ?? "",
            });
        }

        return this.createApplication({
            name: metadata.name,
            organizationId,
            architecture: metadata.architecture,
            packageUrl: metadata.packageUrl ?? "",
            packageName: metadata.packageName ?? "",
            photo: metadata.photo ?? "",
        });
    }

    async createApplication(data: CreateApplicationInput) {
        this.logger.info("Creating application", {
            name: data.name,
            organizationId: data.organizationId,
            architecture: data.architecture,
        });

        try {
            return await this.db.$transaction(async (tx) => {
                const app = await tx.application.create({
                    data: {
                        name: data.name,
                        slug: toSlug(data.name),
                        organizationId: data.organizationId,
                        architecture: data.architecture,
                    },
                    select: { id: true },
                });

                const branch = await tx.branch.create({
                    data: {
                        name: "main",
                        applicationId: app.id,
                        organizationId: data.organizationId,
                    },
                    select: { id: true },
                });

                const deploymentData =
                    data.architecture === ApplicationArchitecture.WEB
                        ? {
                              webDeployment: {
                                  create: {
                                      url: data.url,
                                      file: data.file,
                                      organizationId: data.organizationId,
                                  },
                              },
                          }
                        : {
                              mobileDeployment: {
                                  create: {
                                      packageUrl: data.packageUrl,
                                      packageName: data.packageName,
                                      photo: data.photo,
                                      organizationId: data.organizationId,
                                  },
                              },
                          };

                const deployment = await tx.branchDeployment.create({
                    data: {
                        branchId: branch.id,
                        organizationId: data.organizationId,
                        ...deploymentData,
                    },
                    select: { id: true },
                });

                const snapshot = await tx.branchSnapshot.create({
                    data: {
                        branchId: branch.id,
                        source: TriggerSource.MANUAL,
                        status: SnapshotStatus.active,
                        deploymentId: deployment.id,
                    },
                    select: { id: true },
                });

                await tx.branch.update({
                    where: { id: branch.id },
                    data: {
                        activeSnapshotId: snapshot.id,
                        deploymentId: deployment.id,
                    },
                });

                const result = await tx.application.update({
                    where: { id: app.id },
                    data: { mainBranchId: branch.id },
                    include: deploymentInclude,
                });

                this.logger.info("Application created", { applicationId: app.id, branchId: branch.id });

                return result;
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError();
            }
            throw error;
        }
    }

    async createMinimalApplication(name: string, organizationId: string) {
        this.logger.info("Creating minimal application", { name, organizationId });

        try {
            return await this.db.$transaction(async (tx) => {
                const app = await tx.application.create({
                    data: {
                        name,
                        slug: toSlug(name),
                        organizationId,
                        architecture: ApplicationArchitecture.WEB,
                    },
                    select: { id: true, slug: true, name: true },
                });

                const branch = await tx.branch.create({
                    data: {
                        name: "main",
                        applicationId: app.id,
                        organizationId,
                    },
                    select: { id: true },
                });

                const deployment = await tx.branchDeployment.create({
                    data: {
                        branchId: branch.id,
                        organizationId,
                        webDeployment: {
                            create: {
                                url: "",
                                file: "",
                                organizationId,
                            },
                        },
                    },
                    select: { id: true },
                });

                const snapshot = await tx.branchSnapshot.create({
                    data: {
                        branchId: branch.id,
                        source: TriggerSource.MANUAL,
                        status: SnapshotStatus.active,
                        deploymentId: deployment.id,
                    },
                    select: { id: true },
                });

                await tx.branch.update({
                    where: { id: branch.id },
                    data: {
                        activeSnapshotId: snapshot.id,
                        deploymentId: deployment.id,
                    },
                });

                await tx.application.update({
                    where: { id: app.id },
                    data: { mainBranchId: branch.id },
                });

                await tx.onboardingState.create({
                    data: { applicationId: app.id },
                });

                this.logger.info("Minimal application created", { applicationId: app.id });

                return app;
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError();
            }
            throw error;
        }
    }

    async deleteApplication(id: string, organizationId: string) {
        this.logger.info("Deleting application", { applicationId: id, organizationId });

        const app = await this.db.application.findFirst({
            where: { id, organizationId },
            select: { id: true },
        });
        if (app == null) throw new NotFoundError();

        await this.db.$transaction(async (tx) => {
            // Null out self-referencing FK on application so branches can be deleted
            await tx.application.update({
                where: { id },
                data: { mainBranchId: null },
            });

            // Delete test generations first (they reference snapshots with Restrict)
            await tx.$executeRaw`
                DELETE FROM test_generation
                WHERE snapshot_id IN (
                    SELECT bs.id FROM branch_snapshot bs
                    JOIN branch b ON b.id = bs.branch_id
                    WHERE b.application_id = ${id}
                )
            `;

            // Now Prisma cascade can handle the rest
            await tx.application.delete({ where: { id } });
        });

        this.logger.info("Application deleted", { applicationId: id });
    }

    async updateData(id: string, organizationId: string, data: UpdateDataInput) {
        this.logger.info("Updating application data", { applicationId: id, organizationId });

        try {
            const app = await this.db.application.findFirst({
                where: { id, organizationId },
                select: {
                    mainBranch: {
                        select: { deploymentId: true },
                    },
                },
            });

            if (app == null) throw new NotFoundError();

            const slug = data.name != null ? toSlug(data.name) : undefined;

            const deploymentId = app.mainBranch?.deploymentId;
            if (deploymentId != null) {
                if (data.architecture === ApplicationArchitecture.WEB && data.url != null) {
                    await this.db.webDeployment.upsert({
                        where: { deploymentId },
                        update: { url: data.url, file: data.file },
                        create: {
                            deploymentId,
                            url: data.url,
                            file:
                                data.file ??
                                "s3://autonoma-assets/uploads/default-files/cmmaq609e0032seug0dy32tjh/default-file.png",
                            organizationId,
                        },
                    });
                } else if (
                    data.architecture !== ApplicationArchitecture.WEB &&
                    data.packageUrl != null &&
                    data.packageName != null
                ) {
                    await this.db.mobileDeployment.upsert({
                        where: { deploymentId },
                        update: { packageUrl: data.packageUrl, packageName: data.packageName, photo: data.photo },
                        create: {
                            deploymentId,
                            packageUrl: data.packageUrl,
                            packageName: data.packageName,
                            photo:
                                data.photo ??
                                "s3://autonoma-assets/uploads/default-files/cmmaq609e0032seug0dy32tjh/default-file.png",
                            organizationId,
                        },
                    });
                }
            }

            const result = await this.db.application.update({
                where: { id, organizationId },
                data: { name: data.name, slug },
                include: deploymentInclude,
            });

            this.logger.info("Application data updated", { applicationId: id });

            return result;
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
                throw new NotFoundError();
            }
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError();
            }
            throw error;
        }
    }

    async updateSettings(id: string, organizationId: string, data: UpdateSettingsInput) {
        this.logger.info("Updating application settings", { applicationId: id, organizationId });

        const application = await this.db.application.findFirst({
            where: { id, organizationId },
            select: { id: true },
        });

        if (application == null) throw new NotFoundError();

        const result = await this.db.application.update({
            where: { id },
            data: {
                customInstructions: data.customInstructions,
            },
            include: deploymentInclude,
        });

        this.logger.info("Application settings updated", { applicationId: id });

        return result;
    }
}
