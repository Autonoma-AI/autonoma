import { db, type Prisma, type PrismaClient } from "@autonoma/db";
import { type GitHubAppCredentials, OctokitGitHubApp } from "@autonoma/github";
import {
    type AutonomaCommentState,
    type GitHubCommentStore,
    type PayloadBuilderInput,
    payloadBuilder,
    postOrUpdateCommentOnGithub,
} from "@autonoma/github/comment";
import { type Logger, logger } from "@autonoma/logger";
import { z } from "zod";
import { env } from "./env";

const INCOMPLETE_GENERATION_STATUSES = new Set(["pending", "queued", "running"]);

const generationForCommentSelect = {
    status: true,
    snapshot: {
        select: {
            id: true,
            headSha: true,
            branch: {
                select: {
                    prInfo: { select: { prNumber: true } },
                    application: { select: { githubRepositoryId: true, slug: true } },
                    organization: {
                        select: {
                            id: true,
                            previewkitGithubFeedbackEnabled: true,
                            githubInstallation: {
                                select: { installationId: true, status: true },
                            },
                        },
                    },
                },
            },
            testGenerations: {
                select: {
                    status: true,
                    generationReview: {
                        select: {
                            issue: {
                                select: {
                                    title: true,
                                    severity: true,
                                    dismissed: true,
                                    kind: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    },
} satisfies Prisma.TestGenerationSelect;

type GenerationForComment = {
    status: string;
    snapshot: {
        id: string;
        headSha: string | null;
        branch: {
            prInfo: { prNumber: number } | null;
            application: { githubRepositoryId: number | null; slug: string };
            organization: {
                id: string;
                previewkitGithubFeedbackEnabled: boolean;
                githubInstallation: { installationId: number; status: string } | null;
            };
        };
        testGenerations: Array<{
            status: string;
            generationReview: {
                issue: {
                    title: string;
                    severity: string;
                    dismissed: boolean;
                    kind: string;
                } | null;
            } | null;
        }>;
    };
};

export async function updatePrCommentForGeneration(generationId: string): Promise<void> {
    const log = logger.child({ name: "updatePrCommentForGeneration", generationId });

    const generation: GenerationForComment | null = await db.testGeneration.findUnique({
        where: { id: generationId },
        select: generationForCommentSelect,
    });
    if (generation == null) {
        log.warn("Skipped - generation not found");
        return;
    }

    const snapshot = generation.snapshot;
    const branch = snapshot.branch;
    const prNumber = branch.prInfo?.prNumber;
    const githubRepositoryId = branch.application.githubRepositoryId;
    const organization = branch.organization;
    const installation = organization.githubInstallation;

    if (prNumber == null || githubRepositoryId == null || snapshot.headSha == null) {
        log.info("Skipped PR comment update - generation is not attached to a commentable PR", {
            hasPrNumber: prNumber != null,
            hasGithubRepositoryId: githubRepositoryId != null,
            hasHeadSha: snapshot.headSha != null,
        });
        return;
    }
    if (!organization.previewkitGithubFeedbackEnabled) {
        log.info("Skipped PR comment update - GitHub feedback is disabled for organization", {
            organizationId: organization.id,
            prNumber,
            githubRepositoryId,
        });
        return;
    }
    if (installation == null || installation.status !== "active") {
        log.info("Skipped PR comment update - GitHub installation is not active", {
            organizationId: organization.id,
            prNumber,
            githubRepositoryId,
            installationStatus: installation?.status ?? "missing",
        });
        return;
    }

    const hasIncompleteGenerations = snapshot.testGenerations.some((testGeneration) =>
        INCOMPLETE_GENERATION_STATUSES.has(testGeneration.status),
    );
    if (hasIncompleteGenerations) {
        log.info("Skipped PR comment update - snapshot still has incomplete generations", {
            snapshotId: snapshot.id,
            prNumber,
            incompleteCount: snapshot.testGenerations.filter((testGeneration) =>
                INCOMPLETE_GENERATION_STATUSES.has(testGeneration.status),
            ).length,
        });
        return;
    }

    const githubAppConfig = getGitHubCommentAppConfig(log);
    if (githubAppConfig == null) return;
    const githubApp = new OctokitGitHubApp(githubAppConfig);

    const installationClient = await githubApp.getInstallationClient(installation.installationId);
    const repository = await installationClient.getRepository(githubRepositoryId);
    const previewEnvironment = await db.previewkitEnvironment.findFirst({
        where: { organizationId: organization.id, githubRepositoryId, prNumber },
        select: { urls: true, repoFullName: true },
    });

    const repoFullName = previewEnvironment?.repoFullName ?? repository.fullName;
    const previewUrl = resolvePrimaryUrl(previewEnvironment?.urls);
    const summaryUrl = buildSnapshotSummaryUrl({
        appSlug: branch.application.slug,
        prNumber,
        snapshotId: snapshot.id,
    });
    const payloadInput = buildPayloadInput({
        snapshot,
        prNumber,
        previewUrl,
        summaryUrl,
    });

    await postOrUpdateCommentOnGithub({
        client: installationClient,
        store: createPreviewkitCommentStore(db),
        repoFullName,
        prNumber,
        lastCommitSha: snapshot.headSha,
        payload: payloadBuilder(payloadInput),
    });
}

function buildPayloadInput({
    snapshot,
    prNumber,
    previewUrl,
    summaryUrl,
}: {
    snapshot: GenerationForComment["snapshot"];
    prNumber: number;
    previewUrl: string | undefined;
    summaryUrl: string | undefined;
}): PayloadBuilderInput {
    const selected = snapshot.testGenerations.length;
    const failed = snapshot.testGenerations.filter((testGeneration) => testGeneration.status === "failed").length;
    const passed = snapshot.testGenerations.filter((testGeneration) => testGeneration.status === "success").length;
    const bugs = snapshot.testGenerations
        .flatMap((testGeneration) => {
            const issue = testGeneration.generationReview?.issue;
            if (issue == null || issue.dismissed || issue.kind !== "application_bug") return [];
            return [{ title: issue.title, severity: issue.severity }];
        })
        .slice(0, 3);

    const state: AutonomaCommentState = bugs.length > 0 || failed > 0 ? "critical" : "healthy";
    const payloadInput: PayloadBuilderInput = {
        state,
        prNumber,
        commitSha: snapshot.headSha ?? undefined,
        previewUrl,
        summaryUrl,
        bugs,
        tests: { selected, passed, failed },
    };
    // The healthy/critical headlines match payloadBuilder's defaults, so only the
    // "tests failed but no bug was filed" case needs distinct copy.
    if (failed > 0 && bugs.length === 0) {
        payloadInput.message = "Autonoma could not complete every selected test in this PR.";
    }
    return payloadInput;
}

function buildSnapshotSummaryUrl({
    appSlug,
    prNumber,
    snapshotId,
}: {
    appSlug: string;
    prNumber: number;
    snapshotId: string;
}): string | undefined {
    const appUrl = resolveAppUrl();
    if (appUrl == null) return undefined;

    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/snapshots/${encodeURIComponent(
        snapshotId,
    )}`;
    return new URL(path, appUrl).toString();
}

function resolveAppUrl(): string | undefined {
    if (env.APP_URL != null && env.APP_URL !== "") return env.APP_URL;
    if (env.API_URL == null || env.API_URL === "") return undefined;

    try {
        const url = new URL(env.API_URL);
        if (url.hostname.startsWith("api.")) {
            url.hostname = url.hostname.slice("api.".length);
        }
        return url.toString();
    } catch (err) {
        const log = logger.child({ name: "resolveAppUrl" });
        log.warn("Failed to derive APP_URL from API_URL", { apiUrl: env.API_URL, err });
        return undefined;
    }
}

function getGitHubCommentAppConfig(log: Logger): GitHubAppCredentials | null {
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;
    const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
    const appSlug = env.GITHUB_APP_SLUG;

    const missing: string[] = [];
    if (appId == null) missing.push("GITHUB_APP_ID");
    if (privateKey == null) missing.push("GITHUB_APP_PRIVATE_KEY");
    if (webhookSecret == null) missing.push("GITHUB_APP_WEBHOOK_SECRET");
    if (appSlug == null) missing.push("GITHUB_APP_SLUG");

    if (appId == null || privateKey == null || webhookSecret == null || appSlug == null) {
        log.warn("Skipping PR comment update because GitHub App env is not configured", { missing });
        return null;
    }

    return { appId, privateKey, webhookSecret, appSlug };
}

const UrlsRecordSchema = z.record(z.string(), z.unknown());

function resolvePrimaryUrl(urls: unknown): string | undefined {
    const parsed = UrlsRecordSchema.safeParse(urls);
    if (!parsed.success) return undefined;
    const record = parsed.data;
    const candidate = record.primary ?? record.web ?? Object.values(record).find((value) => typeof value === "string");
    return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

// This DB adapter is intentionally duplicated in apps/previewkit. The @autonoma/github
// package stays free of an @autonoma/db dependency, so each caller owns its store.
function createPreviewkitCommentStore(db: PrismaClient): GitHubCommentStore {
    return {
        async getState(repoFullName, prNumber) {
            const env = await db.previewkitEnvironment.findUnique({
                where: { repoFullName_prNumber: { repoFullName, prNumber } },
                select: { commentId: true, headSha: true },
            });
            return env ?? null;
        },
        async setCommentId(repoFullName, prNumber, commentId) {
            await db.previewkitEnvironment.updateMany({
                where: { repoFullName, prNumber },
                data: { commentId },
            });
        },
    };
}
