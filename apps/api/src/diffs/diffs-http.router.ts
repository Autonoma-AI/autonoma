import { db, TriggerSource } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import { BranchAlreadyHasPendingSnapshotError, SnapshotDraft, TestSuiteUpdater } from "@autonoma/test-updates";
import { cancelDiffsJob, triggerDiffsJob } from "@autonoma/workflow";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { verifyApiKeyAndGetContext } from "../application-setup/verify-api-key";
import { env } from "../env";
import { GitHubInstallationService } from "../github/github-installation.service";

const triggerDiffsBodySchema = z.object({
    repo_full_name: z.string(),
    pr_number: z.number().int().positive(),
    base_sha: z.string().optional(),
    url: z.url(),
    environment: z.string().optional(),
});

export const diffsHttpRouter = new Hono();

diffsHttpRouter.use("*", cors({ origin: "*" }));

diffsHttpRouter.post("/trigger", async (ctx) => {
    const logger = rootLogger.child({ name: "diffsHttpRouter.trigger" });
    logger.info("Received diffs trigger request");

    const apiKeyCtx = await verifyApiKeyAndGetContext(db, ctx.req.header("authorization"));
    if (apiKeyCtx == null) {
        return ctx.json({ error: "Unauthorized" }, 401);
    }

    const parsed = triggerDiffsBodySchema.safeParse(await ctx.req.json());
    if (!parsed.success) {
        return ctx.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, 400);
    }
    const body = parsed.data;

    logger.info("Parsed request body", {
        repoFullName: body.repo_full_name,
        prNumber: body.pr_number,
        baseSha: body.base_sha,
    });

    const member = await db.member.findFirst({
        where: { userId: apiKeyCtx.userId },
        select: { organizationId: true },
    });
    if (member == null) {
        logger.warn("No organization found for user", { userId: apiKeyCtx.userId });
        return ctx.json({ error: "No organization for this API key" }, 403);
    }

    const repo = await db.gitHubRepository.findFirst({
        where: {
            fullName: body.repo_full_name,
            applicationId: { not: null },
            installation: { organizationId: member.organizationId },
        },
        select: { applicationId: true, installation: { select: { installationId: true } } },
    });

    if (repo?.applicationId == null) {
        logger.warn("Repository not linked to an application", {
            repoFullName: body.repo_full_name,
            organizationId: member.organizationId,
        });
        return ctx.json({ error: `Repository ${body.repo_full_name} is not linked to an application` }, 400);
    }

    const githubApp = new GitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });

    const [owner, repoName] = body.repo_full_name.split("/");
    if (owner == null || repoName == null) {
        return ctx.json({ error: "Invalid repo_full_name format" }, 400);
    }

    const installationClient = await githubApp.getInstallationClient(repo.installation.installationId);

    let pullRequest;
    try {
        pullRequest = await installationClient.getPullRequest(owner, repoName, body.pr_number);
    } catch (error) {
        logger.warn("Failed to fetch pull request from GitHub", { prNumber: body.pr_number, error });
        return ctx.json({ error: `Pull request #${body.pr_number} not found` }, 404);
    }

    const normalizedBranch = pullRequest.headRef;
    const headSha = pullRequest.headSha;

    // Find or auto-create the branch so it exists before the snapshot is created.
    let branch = await db.branch.findFirst({
        where: {
            applicationId: repo.applicationId,
            githubRef: normalizedBranch,
        },
        select: { id: true, lastHandledSha: true, prNumber: true },
    });

    if (branch == null) {
        logger.info("Auto-creating branch", {
            applicationId: repo.applicationId,
            branch: normalizedBranch,
            prNumber: body.pr_number,
        });
        const created = await db.branch.create({
            data: {
                name: normalizedBranch,
                githubRef: normalizedBranch,
                prNumber: body.pr_number,
                applicationId: repo.applicationId,
                organizationId: member.organizationId,
            },
            select: { id: true, lastHandledSha: true, prNumber: true },
        });
        branch = created;
    } else if (branch.prNumber == null) {
        await db.branch.update({
            where: { id: branch.id },
            data: { prNumber: body.pr_number },
        });
    }

    const baseSha = body.base_sha ?? branch.lastHandledSha ?? undefined;

    logger.info("Resolved branch and shas", { branchId: branch.id, headSha, baseSha });

    const githubService = new GitHubInstallationService(db, githubApp);

    try {
        let snapshotId: string;

        try {
            const updater = await TestSuiteUpdater.startUpdate({
                db,
                branchId: branch.id,
                organizationId: member.organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });

            snapshotId = updater.snapshotId;
        } catch (error) {
            if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

            // A pending snapshot exists - cancel the running job, discard the snapshot, and start fresh.
            logger.info("Cancelling existing diffs job and discarding pending snapshot", { branchId: branch.id });

            await cancelDiffsJob(branch.id);

            const staleSnapshot = await SnapshotDraft.loadPending({ db, branchId: branch.id });
            await staleSnapshot.discard();

            logger.info("Stale snapshot discarded, starting fresh update", { branchId: branch.id });

            const updater = await TestSuiteUpdater.startUpdate({
                db,
                branchId: branch.id,
                organizationId: member.organizationId,
                source: TriggerSource.WEBHOOK,
                headSha,
                baseSha,
            });
            snapshotId = updater.snapshotId;
        }

        // Create deployment after the snapshot - handleBranchDeployment links to the pending snapshot.
        const { deploymentId } = await githubService.handleBranchDeployment(
            member.organizationId,
            body.repo_full_name,
            normalizedBranch,
            headSha,
            body.url,
            body.environment,
            body.pr_number,
        );

        await db.branch.update({
            where: { id: branch.id },
            data: { lastHandledSha: headSha },
        });

        await triggerDiffsJob({ branchId: branch.id });

        logger.info("Diffs analysis triggered successfully", {
            branchId: branch.id,
            snapshotId,
            deploymentId,
            headSha,
            baseSha,
        });

        return ctx.json({
            ok: true,
            branchId: branch.id,
            snapshotId,
            deploymentId,
        });
    } catch (error) {
        logger.fatal("Failed to trigger diffs analysis", error, {
            repoFullName: body.repo_full_name,
            branch: normalizedBranch,
            sha: headSha,
        });
        return ctx.json({ error: "Failed to trigger diffs analysis" }, 500);
    }
});
