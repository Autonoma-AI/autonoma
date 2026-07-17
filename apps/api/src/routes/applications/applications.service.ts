import { randomBytes } from "node:crypto";
import type { Application, PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, Prisma, SnapshotStatus, TriggerSource } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import type { EncryptionHelper } from "@autonoma/scenario";
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

type UpdateSettingsInput = Pick<Application, "customInstructions" | "testScopeGuidelines">;

class NoMainBranchError extends Error {
    constructor(applicationId: string) {
        super(`Application ${applicationId} has no main branch`);
    }
}

export class ApplicationsService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
        /**
         * Branch name a new app's deploy ref is seeded with until a repo is linked
         * and its real default branch is known (see {@link env.FALLBACK_DEFAULT_BRANCH}).
         * The link-time heal overwrites it with the repo's actual default.
         */
        private readonly fallbackDefaultBranch: string,
    ) {
        super();
    }

    async listApplications(organizationId: string) {
        this.logger.info("Listing applications", { organizationId });

        const apps = await this.db.application.findMany({
            where: { organizationId, disabled: false },
            include: {
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
            },
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

        type AppWithMainBranch = (typeof apps)[number] & {
            mainBranch: NonNullable<(typeof apps)[number]["mainBranch"]>;
        };

        const validApps = apps.filter((app): app is AppWithMainBranch => {
            if (app.mainBranch != null) return true;

            this.logger.fatal("Application has no main branch", new NoMainBranchError(app.id), {
                applicationId: app.id,
                name: app.name,
            });

            return false;
        });

        return validApps.map((app) => ({
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
            const result = await this.db.$transaction(async (tx) => {
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
                        name: this.fallbackDefaultBranch,
                        applicationId: app.id,
                        organizationId: data.organizationId,
                        mainInfo: { create: { applicationId: app.id, githubRef: this.fallbackDefaultBranch } },
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

                const application = await tx.application.update({
                    where: { id: app.id },
                    data: { mainBranchId: branch.id },
                    include: deploymentInclude,
                });

                this.logger.info("Application created", { applicationId: app.id, branchId: branch.id });

                return { application };
            });

            return result.application;
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError();
            }
            throw error;
        }
    }

    async createMinimalApplication(name: string, organizationId: string) {
        this.logger.info("Creating minimal application", { name, organizationId });

        // Generate the webhook shared secret up front so it can be surfaced to the user
        // at the CLI-setup step (in the planner command) instead of being hunted for later.
        const sharedSecret = randomBytes(32).toString("hex");
        const signingSecretEnc = this.encryption.encrypt(sharedSecret);

        try {
            return await this.db.$transaction(async (tx) => {
                const app = await tx.application.create({
                    data: {
                        name,
                        slug: toSlug(name),
                        organizationId,
                        architecture: ApplicationArchitecture.WEB,
                        signingSecretEnc,
                    },
                    select: { id: true, slug: true, name: true },
                });

                const branch = await tx.branch.create({
                    data: {
                        name: this.fallbackDefaultBranch,
                        applicationId: app.id,
                        organizationId,
                        mainInfo: { create: { applicationId: app.id, githubRef: this.fallbackDefaultBranch } },
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
                    data: { applicationId: app.id, step: "github" },
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

    /**
     * Returns the decrypted webhook shared secret for an application so the portal can
     * display it (e.g. in the CLI-setup command). Returns `undefined` for applications
     * created before the secret was generated at creation time.
     */
    async getSharedSecret(applicationId: string, organizationId: string): Promise<{ sharedSecret?: string }> {
        this.logger.info("Getting application shared secret", { applicationId, organizationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true, signingSecretEnc: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.signingSecretEnc == null) return {};

        return { sharedSecret: this.encryption.decrypt(app.signingSecretEnc) };
    }

    /**
     * Resolve an application from a repo full name (`owner/repo`), scoped to the
     * caller's org. `repoFullName` is not stored on `Application`; it maps through
     * any preview environment for that repo (which carries `githubRepositoryId`),
     * then to the org's application linked to that GitHub repository. Throws
     * NotFoundError when no such environment/application exists in the org.
     */
    async findByRepoFullName(
        repoFullName: string,
        organizationId: string,
    ): Promise<{ id: string; githubRepositoryId: number }> {
        this.logger.info("Resolving application by repo full name", { organizationId, extra: { repoFullName } });

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { repoFullName, organizationId, githubRepositoryId: { not: null } },
            select: { githubRepositoryId: true },
        });
        const githubRepositoryId = environment?.githubRepositoryId;
        if (githubRepositoryId == null) {
            throw new NotFoundError(`No preview environment found for ${repoFullName}`);
        }

        const app = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId },
            select: { id: true },
        });
        if (app == null) {
            throw new NotFoundError(`No application linked to ${repoFullName}`);
        }
        return { id: app.id, githubRepositoryId };
    }

    async deleteApplication(id: string, organizationId: string) {
        this.logger.info("Disabling application", { applicationId: id, organizationId });

        const app = await this.db.application.findFirst({
            where: { id, organizationId, disabled: false },
            select: { id: true, slug: true, name: true },
        });
        if (app == null) throw new NotFoundError();

        const suffix = `deleted-${crypto.randomUUID().slice(0, 8)}`;
        await this.db.$transaction(async (tx) => {
            await tx.application.update({
                where: { id },
                data: {
                    disabled: true,
                    slug: `${suffix}-${app.slug}`,
                    name: `${suffix}-${app.name}`,
                    // Free the repo so the same GitHub repository can be linked to a
                    // new application - the unique [organizationId, githubRepositoryId]
                    // constraint would otherwise reject re-linking after a delete.
                    githubRepositoryId: null,
                },
            });

            // Drop the preview secret rows so a re-created app for the same repo
            // does not inherit stale registrations that collide with its own in the
            // reused -pr-0 namespace. The AWS Secrets Manager secret is intentionally
            // left intact - re-creating the app adopts it by name, avoiding the
            // pending-deletion window entirely.
            const removed = await tx.previewkitSecret.deleteMany({ where: { applicationId: id } });
            this.logger.info("Removed preview secret registrations for deleted application", {
                applicationId: id,
                extra: { removed: removed.count },
            });

            // Free the Vercel project too, same reasoning as the GitHub repo above -
            // otherwise it stays "linked" to this now-disabled application forever,
            // invisible both as linked (app is disabled) and as available to link
            // (VercelProject.connection is still set).
            await tx.vercelProjectConnection.deleteMany({ where: { applicationId: id } });
        });

        this.logger.info("Application disabled", { applicationId: id });
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
                testScopeGuidelines: data.testScopeGuidelines,
            },
            include: deploymentInclude,
        });

        this.logger.info("Application settings updated", { applicationId: id });

        return result;
    }
}
