import { db, type Prisma } from "@autonoma/db";
import { type GitHubAppCredentials, OctokitGitHubApp } from "@autonoma/github";
import {
    type AutonomaCommentState,
    createGitHubPrCommentStore,
    type PayloadBuilderInput,
    payloadBuilder,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import { type Logger, logger } from "@autonoma/logger";
import { z } from "zod";
import { env } from "./env";
import { collectBugsForComment, type CommentIssueForBug } from "./pr-comment-bugs";
import { collectTestStatsForComment, type CommentTestAssignmentForResult } from "./pr-comment-results";

const INCOMPLETE_GENERATION_STATUSES = new Set(["pending", "queued", "running"]);

const generationForCommentSelect = {
    status: true,
    snapshot: {
        select: {
            id: true,
            status: true,
            headSha: true,
            branch: {
                select: {
                    prInfo: { select: { prNumber: true } },
                    application: { select: { githubRepositoryId: true, slug: true } },
                    deployment: {
                        select: {
                            webDeployment: { select: { url: true } },
                        },
                    },
                    organization: {
                        select: {
                            id: true,
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
                    updatedAt: true,
                    testPlan: { select: { testCaseId: true } },
                    generationReview: {
                        select: {
                            issue: {
                                select: {
                                    id: true,
                                    title: true,
                                    severity: true,
                                    dismissed: true,
                                    kind: true,
                                    bug: { select: { id: true, title: true, severity: true } },
                                },
                            },
                        },
                    },
                },
            },
            testCaseAssignments: {
                select: {
                    testCaseId: true,
                    quarantineIssueId: true,
                    runs: {
                        select: {
                            status: true,
                            startedAt: true,
                            createdAt: true,
                            runReview: {
                                select: {
                                    issue: {
                                        select: {
                                            id: true,
                                            title: true,
                                            severity: true,
                                            dismissed: true,
                                            kind: true,
                                            bug: { select: { id: true, title: true, severity: true } },
                                        },
                                    },
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
        status: string;
        headSha: string | null;
        branch: {
            prInfo: { prNumber: number } | null;
            application: { githubRepositoryId: number | null; slug: string };
            deployment: { webDeployment: { url: string } | null } | null;
            organization: {
                id: string;
                githubInstallation: { installationId: number; status: string } | null;
            };
        };
        testGenerations: Array<{
            status: string;
            updatedAt: Date;
            testPlan: { testCaseId: string };
            generationReview: {
                issue: {
                    id: string;
                    title: string;
                    severity: string;
                    dismissed: boolean;
                    kind: string;
                    bug: { id: string; title: string; severity: string } | null;
                } | null;
            } | null;
        }>;
        testCaseAssignments: Array<{
            testCaseId: string;
            quarantineIssueId: string | null;
            runs: Array<{
                status: string;
                startedAt: Date | null;
                createdAt: Date;
                runReview: {
                    issue: {
                        id: string;
                        title: string;
                        severity: string;
                        dismissed: boolean;
                        kind: string;
                        bug: { id: string; title: string; severity: string } | null;
                    } | null;
                } | null;
            }>;
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
    if (installation == null || installation.status !== "active") {
        log.info("Skipped PR comment update - GitHub installation is not active", {
            organizationId: organization.id,
            prNumber,
            githubRepositoryId,
            installationStatus: installation?.status ?? "missing",
        });
        return;
    }

    // Skip superseded snapshots: an older one finishing out-of-order would otherwise repost
    // its stale results (the runs comment reposts with allow-new-head, so its sha isn't rejected).
    if (snapshot.status === "superseded") {
        log.info("Skipped PR comment update - snapshot superseded by a newer push", {
            snapshotId: snapshot.id,
            prNumber,
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
    const previewUrl = branch.deployment?.webDeployment?.url ?? resolvePrimaryUrl(previewEnvironment?.urls);
    const summaryUrl = buildSnapshotSummaryUrl({
        appSlug: branch.application.slug,
        prNumber,
    });
    const assetBaseUrl = resolveCommentAssetBaseUrl({
        explicitAssetBaseUrl: env.GITHUB_COMMENT_ASSET_BASE_URL,
        appUrl: resolveAppUrl(),
    });
    const payloadInput = buildPayloadInput({
        snapshot,
        prNumber,
        previewUrl,
        summaryUrl,
        assetBaseUrl,
    });

    await postOrUpdateCommentOnGithub({
        client: installationClient,
        store: createGitHubPrCommentStore(db, "runs"),
        repoFullName,
        prNumber,
        lastCommitSha: snapshot.headSha,
        staleGuard: "allow-new-head",
        // Repost so the latest results land at the bottom of the PR conversation.
        mode: "repost",
        payload: payloadBuilder(payloadInput),
    });
}

function buildPayloadInput({
    snapshot,
    prNumber,
    previewUrl,
    summaryUrl,
    assetBaseUrl,
}: {
    snapshot: GenerationForComment["snapshot"];
    prNumber: number;
    previewUrl: string | undefined;
    summaryUrl: string | undefined;
    assetBaseUrl: string | undefined;
}): PayloadBuilderInput {
    const { selected, passed, failed } = collectTestStatsForComment({
        testGenerations: snapshot.testGenerations,
        testCaseAssignments: snapshot.testCaseAssignments satisfies CommentTestAssignmentForResult[],
    });
    const bugs = collectBugsForComment([
        ...snapshot.testGenerations.map((testGeneration) => testGeneration.generationReview?.issue ?? null),
        ...snapshot.testCaseAssignments.flatMap((assignment) =>
            assignment.runs.map((run) => run.runReview?.issue ?? null),
        ),
    ] satisfies CommentIssueForBug[]);

    const state: AutonomaCommentState = bugs.length > 0 || failed > 0 ? "critical" : "healthy";
    const payloadInput: PayloadBuilderInput = {
        state,
        prNumber,
        commitSha: snapshot.headSha ?? undefined,
        assetBaseUrl,
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

function buildSnapshotSummaryUrl({ appSlug, prNumber }: { appSlug: string; prNumber: number }): string {
    const appUrl = resolveAppUrl();
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}`;
    return new URL(path, appUrl).toString();
}

function resolveAppUrl(): string {
    if (env.SENTRY_ENV === "beta") return "https://beta.autonoma.app";
    if (env.SENTRY_ENV.startsWith("alpha-")) {
        const alphaHash = env.SENTRY_ENV.slice("alpha-".length);
        return `https://${alphaHash}.alpha.autonoma.app`;
    }
    return "https://autonoma.app";
}

const UrlsRecordSchema = z.record(z.string(), z.unknown());

function resolvePrimaryUrl(urls: unknown): string | undefined {
    const parsed = UrlsRecordSchema.safeParse(urls);
    if (!parsed.success) return undefined;
    const record = parsed.data;
    const candidate = record.primary ?? record.web ?? Object.values(record).find((value) => typeof value === "string");
    return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
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
