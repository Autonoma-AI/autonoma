import { createHmac, timingSafeEqual } from "node:crypto";
import { processVercelInvoiceNotPaid, processVercelInvoicePaid, processVercelInvoiceRefunded } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { ThirdPartyError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { z } from "zod";
import { getVercelEncryptionHelper } from "../context";
import { diffsTriggerService } from "../diffs/diffs-service";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { buildSdkUrl } from "../routes/onboarding/sdk-url";
import {
    applyVercelProtectionBypassHeader,
    applyVercelSharedSecretEnv,
    buildVercelSsoRedirectUrl,
} from "./vercel-helpers";
import { fetchVercelProjectDetails, registerVercelCheck, updateVercelProtectionBypass } from "./vercel-project-api";

const logger = rootLogger.child({ name: "VercelWebhooksRouter" });

const VERCEL_API_BASE = "https://api.vercel.com";

const githubApp = buildGitHubApp(env);
const githubInstallationService = new GitHubInstallationService(db, githubApp);

// ─── Webhook payload schemas ──────────────────────────────────────────────────

const ProjectConnectPayloadSchema = z.object({
    installationId: z.string(),
    projectId: z.string(),
    resourceId: z.string(),
    team: z.object({ id: z.string() }),
    targets: z.array(z.string()),
});

const CheckRunStartPayloadSchema = z.object({
    checkRun: z.object({ id: z.string(), checkId: z.string() }),
    deployment: z.object({
        id: z.string(),
        // Not reliably present on this event - some deployment.checkrun.start
        // payloads omit it. Fall back to fetching the deployment's own details
        // from Vercel's API when absent (see `fetchDeploymentDetails`).
        url: z.string().optional(),
        meta: z
            .object({
                githubCommitRef: z.string().optional(),
                githubCommitSha: z.string().optional(),
            })
            .optional(),
    }),
    project: z.object({ id: z.string() }),
    team: z.object({ id: z.string() }),
});

const InvoicePayloadSchema = z.object({
    installationId: z.string(),
    invoiceId: z.string(),
});

const WebhookBodySchema = z.object({
    type: z.string(),
    id: z.string(),
    createdAt: z.number(),
    payload: z.record(z.string(), z.unknown()),
});

// ─── Vercel API response schemas ──────────────────────────────────────────────

const VercelDeploymentMetaSchema = z.object({
    githubCommitSha: z.string().optional(),
    githubCommitRef: z.string().optional(),
    githubRepoId: z.coerce.number().optional(),
    // Present on deployments triggered from an open PR branch. Not part of
    // Vercel's documented OpenAPI schema (`meta` is typed as a loose string
    // map there), but a long-standing, widely relied-on field in practice -
    // treated as best-effort: absent means "not a PR deployment we can trace".
    githubPrId: z.coerce.number().optional(),
});

const VercelDeploymentResponseSchema = z.object({
    meta: VercelDeploymentMetaSchema.optional(),
    target: z.string().nullable().optional(),
    url: z.string().optional(),
});

type ProjectConnectPayload = z.infer<typeof ProjectConnectPayloadSchema>;
type CheckRunStartPayload = z.infer<typeof CheckRunStartPayloadSchema>;
type WebhookBody = z.infer<typeof WebhookBodySchema>;
type VercelDeploymentMeta = z.infer<typeof VercelDeploymentMetaSchema>;

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(rawBody: string, signature: string): boolean {
    if (env.VERCEL_CLIENT_SECRET == null) {
        logger.error("Cannot verify Vercel webhook signature: VERCEL_CLIENT_SECRET not configured");
        return false;
    }

    const expected = createHmac("sha1", env.VERCEL_CLIENT_SECRET).update(rawBody).digest("hex");

    if (expected.length !== signature.length) return false;

    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(signature, "utf-8"));
}

// ─── Vercel API helpers ───────────────────────────────────────────────────────

async function updateVercelCheckRun(
    accessToken: string,
    deploymentId: string,
    checkRunId: string,
    status: "queued" | "running" | "completed",
    options?: {
        conclusion?: "canceled" | "timeout" | "failed" | "neutral" | "succeeded" | "skipped";
        conclusionText?: string;
        externalUrl?: string;
    },
): Promise<void> {
    logger.info("Updating Vercel check run", { deploymentId, checkRunId, status });

    let res: Response;
    try {
        res = await fetch(`${VERCEL_API_BASE}/v2/deployments/${deploymentId}/check-runs/${checkRunId}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                status,
                ...(options?.externalUrl != null && { externalUrl: options.externalUrl }),
                ...(options?.conclusion != null && { conclusion: options.conclusion }),
                ...(options?.conclusionText != null && { conclusionText: options.conclusionText }),
            }),
        });
    } catch (error) {
        // Best-effort status update - never let a failure here mask the underlying
        // diffs-trigger outcome the caller already logged.
        logger.error("Network error updating Vercel check run", { deploymentId, checkRunId, error });
        return;
    }

    if (!res.ok) {
        const body = await res.text();
        logger.warn("Failed to update Vercel check run", { deploymentId, checkRunId, status: res.status, body });
    } else {
        logger.info("Vercel check run updated", { deploymentId, checkRunId, status });
    }
}

async function fetchDeploymentDetails(
    deploymentId: string,
    teamId: string,
    accessToken: string,
): Promise<{ meta: VercelDeploymentMeta; target: string | null; url: string | undefined }> {
    logger.info("Fetching Vercel deployment details", { deploymentId, teamId });

    let res: Response;
    try {
        res = await fetch(`${VERCEL_API_BASE}/v13/deployments/${deploymentId}?teamId=${teamId}`, {
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        });
    } catch (error) {
        throw new ThirdPartyError("vercel", error, "Network error fetching Vercel deployment details");
    }

    if (!res.ok) {
        const body = await res.text();
        logger.warn("Failed to fetch Vercel deployment details", { deploymentId, status: res.status, body });
        return { meta: {}, target: null, url: undefined };
    }

    const data = VercelDeploymentResponseSchema.parse(await res.json());
    logger.info("Fetched Vercel deployment details", {
        deploymentId,
        meta: data.meta,
        target: data.target,
        url: data.url,
    });
    return { meta: data.meta ?? {}, target: data.target ?? null, url: data.url };
}

// ─── Handler: integration-resource.project-connected ─────────────────────────

async function handleProjectConnected(payload: ProjectConnectPayload): Promise<void> {
    const { installationId, projectId, team } = payload;

    logger.info("Handling project-connected webhook", { installationId, projectId });

    const installation = await db.vercelInstallation.findUnique({
        where: { vercelInstallationId: installationId },
        select: { id: true, organizationId: true, accessTokenEnc: true, vercelInstallationId: true },
    });

    if (installation == null) {
        logger.error("Installation not found for project-connected", { installationId });
        return;
    }

    if (installation.accessTokenEnc == null) {
        logger.error("Installation has no access token", { installationId });
        return;
    }

    const accessToken = getVercelEncryptionHelper().decrypt(installation.accessTokenEnc);

    const existing = await db.vercelProject.findUnique({
        where: {
            vercelProjectId_vercelInstallationId: { vercelProjectId: projectId, vercelInstallationId: installation.id },
        },
        select: { id: true },
    });

    if (existing != null) {
        logger.info("Project already known, skipping", { projectId });
        return;
    }

    const {
        name: projectName,
        productionUrl,
        githubRepoId,
    } = await fetchVercelProjectDetails(projectId, team.id, accessToken);
    const secret = await updateVercelProtectionBypass(projectId, team.id, accessToken);
    const protectionBypassSecretEnc = getVercelEncryptionHelper().encrypt(secret);
    const checkId = await registerVercelCheck(projectId, team.id, accessToken, installation.vercelInstallationId);

    const project = await db.vercelProject.create({
        data: {
            vercelProjectId: projectId,
            vercelInstallationId: installation.id,
            name: projectName,
            productionUrl,
            githubRepositoryId: githubRepoId,
            protectionBypassSecretEnc,
            vercelCheckId: checkId,
        },
        select: { id: true },
    });

    logger.info("Vercel project recorded", { projectId, vercelProjectDbId: project.id });

    // Applications are created exclusively through the GitHub-based
    // onboarding flow or the manual "link project" onboarding action, never
    // automatically here - without a matching GitHub repo, the project stays
    // unlinked and shows up in the onboarding "connect a Vercel project" list.
    const existingApp =
        githubRepoId != null
            ? await db.application.findFirst({
                  where: { organizationId: installation.organizationId, githubRepositoryId: githubRepoId },
                  select: { id: true },
              })
            : null;

    if (existingApp == null) {
        logger.info("No existing application matches this Vercel project's GitHub repo, leaving unlinked", {
            projectId,
            githubRepoId,
            organizationId: installation.organizationId,
        });
        return;
    }

    const connection = await db.vercelProjectConnection.create({
        data: { projectId: project.id, applicationId: existingApp.id },
        select: { id: true },
    });

    await applyVercelProtectionBypassHeader(existingApp.id, secret);
    await applyVercelSharedSecretEnv(existingApp.id, projectId, team.id, accessToken);

    logger.info("Linked Vercel project to existing application", {
        applicationId: existingApp.id,
        connectionId: connection.id,
    });
}

// ─── Handler: deployment.checkrun.start ──────────────────────────────────────

/**
 * Corrects the application's placeholder `main` ref (set at project-connect
 * time, before we know the project's real default branch) to the branch name
 * a production deployment actually reports. No-op once it already matches, so
 * this only ever runs the write on the very first production deployment.
 */
async function resolveMainBranchGithubRef(applicationId: string, branchId: string, branchName: string): Promise<void> {
    const mainInfo = await db.mainBranchInfo.findUnique({
        where: { applicationId },
        select: { githubRef: true },
    });

    if (mainInfo == null || mainInfo.githubRef === branchName) return;

    await db.mainBranchInfo.update({
        where: { applicationId },
        data: { githubRef: branchName },
    });
    logger.info("Corrected main branch github ref from Vercel deployment", {
        applicationId,
        branchId,
        from: mainInfo.githubRef,
        to: branchName,
    });
}

async function handleCheckRunStart(payload: CheckRunStartPayload): Promise<void> {
    const { checkRun, deployment, project } = payload;

    logger.info("Handling check-run start webhook", {
        checkRunId: checkRun.id,
        deploymentId: deployment.id,
        projectId: project.id,
    });

    const projectConnection = await db.vercelProjectConnection.findFirst({
        where: { project: { vercelProjectId: project.id } },
        select: {
            id: true,
            applicationId: true,
            project: {
                select: {
                    protectionBypassSecretEnc: true,
                    installation: {
                        select: { organizationId: true, accessTokenEnc: true, vercelInstallationId: true },
                    },
                },
            },
        },
    });

    if (projectConnection == null) {
        logger.info("No project connection found for deployment, skipping", { projectId: project.id });
        return;
    }

    if (projectConnection.project.installation.accessTokenEnc == null) {
        logger.error("Installation has no access token", { projectId: project.id });
        return;
    }

    const { organizationId } = projectConnection.project.installation;
    const accessToken = getVercelEncryptionHelper().decrypt(projectConnection.project.installation.accessTokenEnc);

    const application = await db.application.findUnique({
        where: { id: projectConnection.applicationId },
        select: { id: true, slug: true, githubRepositoryId: true, mainBranch: { select: { id: true } } },
    });

    if (application == null) {
        logger.error("Application not found for project connection", { projectConnectionId: projectConnection.id });
        return;
    }

    const {
        meta: deploymentMeta,
        url: fetchedUrl,
        target,
    } = await fetchDeploymentDetails(deployment.id, payload.team.id, accessToken);
    const headSha = deploymentMeta.githubCommitSha ?? deployment.meta?.githubCommitSha;
    const deploymentHost = deployment.url ?? fetchedUrl;

    let repoId = application.githubRepositoryId;
    if (repoId == null && deploymentMeta.githubRepoId != null) {
        try {
            await githubInstallationService.linkRepository(organizationId, application.id, deploymentMeta.githubRepoId);
            repoId = deploymentMeta.githubRepoId;
            logger.info("Auto-linked GitHub repository from Vercel deployment metadata", {
                applicationId: application.id,
                repoId,
            });
        } catch (error) {
            logger.warn("Failed to auto-link GitHub repository from Vercel deployment metadata", {
                applicationId: application.id,
                githubRepoId: deploymentMeta.githubRepoId,
                error,
            });
        }
    }

    if (repoId == null) {
        logger.info("GitHub not connected for application, skipping diffs", { applicationId: application.id });
        await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
            conclusion: "skipped",
            conclusionText: "No GitHub repository connected to this application.",
        });
        return;
    }

    let rawRef = deploymentMeta.githubCommitRef ?? deployment.meta?.githubCommitRef;
    // Vercel doesn't always populate `meta.githubCommitRef` on this event, even
    // for PR deployments - defaulting straight to "main" in that case would
    // misroute a real PR deployment into the main-branch diffs path (since
    // `DiffsTriggerService.triggerDiffs` decides main-vs-PR purely by comparing
    // this ref against the app's main branch ref). When we know it's a PR
    // (`githubPrId` is set), resolve the real branch from GitHub instead of
    // guessing.
    if (rawRef == null && deploymentMeta.githubPrId != null) {
        try {
            const pr = await githubInstallationService.getPullRequest(
                organizationId,
                repoId,
                deploymentMeta.githubPrId,
            );
            rawRef = pr.headRef;
        } catch (error) {
            logger.warn("Failed to resolve PR branch from GitHub, falling back to main", {
                applicationId: application.id,
                prNumber: deploymentMeta.githubPrId,
                error,
            });
        }
    }
    const branchName = rawRef?.replace(/^refs\/heads\//, "") ?? "main";

    if (headSha == null) {
        logger.info("No githubCommitSha available for deployment, skipping diffs", { deploymentId: deployment.id });
        await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
            conclusion: "skipped",
            conclusionText: "Deployment has no associated git commit SHA.",
        });
        return;
    }

    if (deploymentHost == null) {
        logger.info("No deployment URL available (webhook and API both missing it), skipping diffs", {
            deploymentId: deployment.id,
        });
        await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
            conclusion: "skipped",
            conclusionText: "Deployment has no resolvable URL.",
        });
        return;
    }

    // Only ever correct the main branch's ref from a production deployment -
    // doing this for a PR/preview deployment would overwrite the real main ref
    // with the PR's own branch name, which then makes `DiffsTriggerService`'s
    // main-vs-PR routing (a straight ref comparison) misidentify every future
    // PR deployment as the main branch.
    if (application.mainBranch != null && target === "production") {
        await resolveMainBranchGithubRef(application.id, application.mainBranch.id, branchName);
    }

    const deploymentUrl = `https://${deploymentHost}`;
    const webhookHeaders =
        projectConnection.project.protectionBypassSecretEnc != null
            ? {
                  "x-vercel-protection-bypass": getVercelEncryptionHelper().decrypt(
                      projectConnection.project.protectionBypassSecretEnc,
                  ),
              }
            : undefined;

    logger.info("Resolved deployment details", { deploymentUrl, branchName, headSha, prId: deploymentMeta.githubPrId });

    // Routed through Vercel's own marketplace SSO broker rather than linking
    // straight at our app - a bare link would hit our login wall for any
    // Vercel team member who never personally clicked "Open in Autonoma"
    // themselves, since no Autonoma user account exists for them yet. Vercel
    // confirms team membership on its own and hands back an SSO code our
    // `/v1/vercel/callback?mode=sso` handler exchanges for a real session.
    const targetUrl =
        deploymentMeta.githubPrId != null
            ? `${env.APP_URL}/app/${application.slug}/pull-requests/${deploymentMeta.githubPrId}`
            : `${env.APP_URL}/app/${application.slug}`;
    const externalUrl = buildVercelSsoRedirectUrl(
        projectConnection.project.installation.vercelInstallationId,
        payload.team.id,
        targetUrl,
    );

    await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "running", { externalUrl });

    let result: Awaited<ReturnType<typeof diffsTriggerService.triggerDiffs>>;
    try {
        result = await diffsTriggerService.triggerDiffs({
            organizationId,
            repoId,
            githubRef: branchName,
            prNumber: deploymentMeta.githubPrId,
            url: deploymentUrl,
            webhookUrl: buildSdkUrl(deploymentUrl),
            webhookHeaders,
        });
    } catch (error) {
        logger.error("Failed to trigger diffs for Vercel deployment", { deploymentId: deployment.id, error });
        await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
            conclusion: "failed",
            conclusionText: "Failed to trigger diffs analysis.",
        });
        return;
    }

    if (result.snapshotId == null) {
        logger.info("Diffs trigger was a no-op for Vercel deployment", { deploymentId: deployment.id, ...result });
        await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
            conclusion: "skipped",
            conclusionText: "No new commits to analyze.",
        });
        return;
    }

    // A deployment can have more than one check registered against it (e.g.
    // duplicate "Autonoma" checks left over from reconnecting the Vercel
    // project several times), so more than one deployment.checkrun.start
    // delivery can arrive for the same deployment with different checkRunIds.
    // vercelDeploymentId is unique - only the first delivery records it.
    const existingDeployment = await db.vercelDeployment.findUnique({
        where: { vercelDeploymentId: deployment.id },
        select: { id: true },
    });
    if (existingDeployment == null) {
        await db.vercelDeployment.create({
            data: {
                vercelDeploymentId: deployment.id,
                vercelCheckRunId: checkRun.id,
                projectConnectionId: projectConnection.id,
                branchSnapshotId: result.snapshotId,
            },
        });
    } else {
        logger.info("Vercel deployment already recorded from a prior check-run delivery, skipping", {
            deploymentId: deployment.id,
            checkRunId: checkRun.id,
        });
    }

    await updateVercelCheckRun(accessToken, deployment.id, checkRun.id, "completed", {
        conclusion: "succeeded",
        conclusionText: "Diffs analysis triggered.",
        externalUrl,
    });

    logger.info("Diffs job triggered for Vercel deployment", { deploymentId: deployment.id, ...result });
}

// ─── Handler: marketplace.invoice.paid ───────────────────────────────────────

async function handleInvoicePaid(payload: unknown): Promise<void> {
    const { installationId, invoiceId } = InvoicePayloadSchema.parse(payload);
    await processVercelInvoicePaid(installationId, invoiceId);
}

async function handleInvoiceNotPaid(payload: unknown): Promise<void> {
    const { installationId } = InvoicePayloadSchema.pick({ installationId: true }).parse(payload);
    await processVercelInvoiceNotPaid(installationId);
}

async function handleInvoiceRefunded(payload: unknown): Promise<void> {
    const { installationId, invoiceId } = InvoicePayloadSchema.parse(payload);
    await processVercelInvoiceRefunded(installationId, invoiceId);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const vercelWebhooksRouter = new Hono();

vercelWebhooksRouter.post("/", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-vercel-signature");

    if (signature == null || signature === "") {
        logger.warn("Missing x-vercel-signature header");
        return c.json({ error: "Unauthorized" }, 401);
    }

    if (!verifySignature(rawBody, signature)) {
        logger.warn("Invalid Vercel webhook signature");
        return c.json({ error: "Unauthorized" }, 401);
    }

    let body: WebhookBody;
    try {
        body = WebhookBodySchema.parse(JSON.parse(rawBody));
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    logger.info("Vercel webhook received", { type: body.type, id: body.id });

    try {
        switch (body.type) {
            case "integration-resource.project-connected":
                await handleProjectConnected(ProjectConnectPayloadSchema.parse(body.payload));
                break;
            case "deployment.checkrun.start":
                await handleCheckRunStart(CheckRunStartPayloadSchema.parse(body.payload));
                break;
            case "marketplace.invoice.paid":
                await handleInvoicePaid(body.payload);
                break;
            case "marketplace.invoice.notpaid":
                await handleInvoiceNotPaid(body.payload);
                break;
            case "marketplace.invoice.refunded":
                await handleInvoiceRefunded(body.payload);
                break;
            default:
                logger.info("Ignoring webhook type", { type: body.type });
        }

        return c.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Vercel webhook handler failed", { type: body.type, id: body.id, error: message });
        return c.json({ error: "Webhook processing failed", details: message }, 500);
    }
});
