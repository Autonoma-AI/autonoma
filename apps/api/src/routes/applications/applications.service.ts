import { createHash, randomBytes } from "node:crypto";
import type { Application, PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, Prisma, SnapshotStatus, TriggerSource } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import type { EncryptionHelper } from "@autonoma/scenario";
import { APPLICATION_INSTRUCTIONS_MAX_LENGTH } from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import { cancelInFlightAnalysisRuns } from "../../analysis/cancel-in-flight-analysis-runs";
import { FIRST_ONBOARDING_STEP, OnboardingStepSchema } from "../onboarding/onboarding-step-order";
import { Service } from "../service";
import { ApplicationInstructionsConflictError } from "./application-instructions-conflict-error";

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
    file?: string;
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

/** The two free-text instruction fields, as stored. */
type ApplicationInstructions = Pick<Application, "customInstructions" | "testScopeGuidelines">;

interface UpdateInstructionsInput {
    applicationId: string;
    organizationId: string;
    /**
     * Each field is applied only when present: omitted leaves it untouched, `null` clears it. A
     * caller editing one field must not have to resend the other, which is how the value it never
     * meant to touch gets rewritten from a stale copy.
     */
    customInstructions?: string | null;
    testScopeGuidelines?: string | null;
    /** The fingerprint the caller read before editing. Omitted makes the write unconditional. */
    baseFingerprint?: string;
}

/** Trim, and treat blank as cleared, so "  " and "" and null are one stored state. */
function normalizeInstructions(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value == null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

/**
 * Identifies one revision of the pair of fields, so a write can tell whether it is editing what
 * its caller actually read. Covers both fields together because they are read and written as one
 * document, and a caller that read a stale copy of either is editing blind.
 */
function instructionsFingerprint({ customInstructions, testScopeGuidelines }: ApplicationInstructions): string {
    return createHash("sha256").update(JSON.stringify({ customInstructions, testScopeGuidelines })).digest("hex");
}

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

        // Parsed rather than passed through as a string: this is what carries the step to the
        // frontend, and an untyped one there is an unchecked comparison against a literal. The
        // column is a Postgres enum, so a parse failure means the two have drifted.
        //
        // An unreadable step falls back to the FIRST step, never to an absent row. A row that is
        // not there means "legacy app, predates onboarding, perfectly usable" to the app hub, so
        // dropping it would present an application we cannot read as ready to use. Falling back to
        // the start of the flow keeps the safe direction: the app is offered as setup to resume.
        const stateByAppId = new Map(
            onboardingStates.map((row) => {
                const parsed = OnboardingStepSchema.safeParse(row.step);
                if (!parsed.success) {
                    this.logger.error("Onboarding step is not a known step; treating the app as unfinished", {
                        applicationId: row.application_id,
                        extra: { step: row.step },
                    });
                }
                return [row.application_id, { step: parsed.data ?? FIRST_ONBOARDING_STEP }] as const;
            }),
        );

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
                file: metadata.file,
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

                // Every application needs one. Without it `hasGoneLive` reads the app as
                // not live - correct as a default, but permanent, because nothing else creates the
                // row and no screen can advance a step that does not exist. Onboarding reads are
                // queries and must not write, so this is the only thing that materialises it.
                await tx.onboardingState.create({
                    data: { applicationId: app.id, step: "github" },
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

            // Drop the preview secrets so a re-created app for the same repo does not
            // inherit stale values that collide with its own in the reused -pr-0
            // namespace. These rows hold the only copy, so this is a real deletion,
            // not the release of a registration.
            const removed = await tx.previewkitSecret.deleteMany({ where: { applicationId: id } });
            this.logger.info("Removed preview secrets for deleted application", {
                applicationId: id,
                extra: { removed: removed.count },
            });

            // Same reasoning for the preview config document: the row holds the only
            // copy of the topology, and a re-created app for the same repo must
            // author its own rather than inherit this one. Kept rows are also
            // unmigratable - every config migration resolves the repo through
            // githubRepositoryId, which this delete just nulled - so they would
            // accumulate as permanent noise in the config table.
            const removedConfigs = await tx.previewkitConfig.deleteMany({ where: { applicationId: id } });
            this.logger.info("Removed preview config for deleted application", {
                applicationId: id,
                extra: { removed: removedConfigs.count },
            });

            // The activation trigger config is the same shape of thing: a 1:1
            // config row holding the only copy of a repo-level opt-in, reachable
            // only through (organizationId, githubRepositoryId). Nulling the repo id
            // above orphans it permanently, and a new app for the repo must start
            // from the code defaults (nothing runs until explicitly asked).
            const removedTriggers = await tx.applicationTriggerConfig.deleteMany({ where: { applicationId: id } });
            this.logger.info("Removed activation trigger config for deleted application", {
                applicationId: id,
                extra: { removed: removedTriggers.count },
            });

            // Revoke any pairing code still outstanding for this app. The onboarding
            // state row survives the delete, so a code minted moments before it would
            // otherwise keep pairing agents to an application that no longer exists,
            // for the rest of its TTL - while the user, having started over, is looking
            // at a different app's code entirely.
            const revoked = await tx.onboardingState.updateMany({
                where: { applicationId: id, agentPairingCode: { not: null } },
                data: { agentPairingCode: null, agentPairingExpiresAt: null },
            });
            this.logger.info("Revoked pairing code for deleted application", {
                applicationId: id,
                extra: { revoked: revoked.count },
            });

            // Free the Vercel project too, same reasoning as the GitHub repo above -
            // otherwise it stays "linked" to this now-disabled application forever,
            // invisible both as linked (app is disabled) and as available to link
            // (VercelProject.connection is still set).
            await tx.vercelProjectConnection.deleteMany({ where: { applicationId: id } });
        });

        // The repo id was just nulled, so any run already executing would crash on the null id mid-flight; cancel
        // it so it settles cleanly as `cancelled` instead. After the commit, so a run that races past the cancel
        // and re-reads the repo id already finds it null (the containment safety net).
        await cancelInFlightAnalysisRuns(this.db, { applicationId: id }, this.logger);

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
                            file: data.file,
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

    /**
     * The two instruction fields plus the fingerprint a write must quote back. Separate from
     * `listApplications` (which already returns them on the row) because a caller that is about to
     * edit needs the fingerprint, and a whole application row does not carry one.
     */
    async getInstructions(id: string, organizationId: string) {
        this.logger.info("Reading application instructions", { applicationId: id, organizationId });

        const application = await this.db.application.findFirst({
            where: { id, organizationId },
            select: { customInstructions: true, testScopeGuidelines: true },
        });

        if (application == null) throw new NotFoundError();

        this.logger.info("Application instructions read", { applicationId: id });

        return {
            customInstructions: application.customInstructions,
            testScopeGuidelines: application.testScopeGuidelines,
            fingerprint: instructionsFingerprint(application),
            maxLength: APPLICATION_INSTRUCTIONS_MAX_LENGTH,
        };
    }

    /**
     * Write one or both instruction fields, refusing a write whose base is stale.
     *
     * The read and the compare-and-set share a transaction because they are the whole point: these
     * fields are hand-written prose with no version history behind them, so a write that lands on
     * top of an edit it never saw destroys words nobody can get back.
     */
    async updateInstructions(input: UpdateInstructionsInput) {
        const { applicationId, organizationId, baseFingerprint } = input;
        this.logger.info("Updating application instructions", { applicationId, organizationId });

        const result = await this.db.$transaction(async (tx) => {
            const application = await tx.application.findFirst({
                where: { id: applicationId, organizationId },
                select: { customInstructions: true, testScopeGuidelines: true },
            });

            if (application == null) throw new NotFoundError();

            const currentFingerprint = instructionsFingerprint(application);
            if (baseFingerprint != null && baseFingerprint !== currentFingerprint) {
                this.logger.warn("Rejecting a stale instructions write", {
                    applicationId,
                    extra: { baseFingerprint, currentFingerprint },
                });
                throw new ApplicationInstructionsConflictError(applicationId, {
                    current: application,
                    currentFingerprint,
                    baseFingerprint,
                });
            }

            return await tx.application.update({
                where: { id: applicationId },
                data: {
                    customInstructions: normalizeInstructions(input.customInstructions),
                    testScopeGuidelines: normalizeInstructions(input.testScopeGuidelines),
                },
                select: { customInstructions: true, testScopeGuidelines: true },
            });
        });

        this.logger.info("Application instructions updated", { applicationId });

        return {
            customInstructions: result.customInstructions,
            testScopeGuidelines: result.testScopeGuidelines,
            fingerprint: instructionsFingerprint(result),
        };
    }
}
