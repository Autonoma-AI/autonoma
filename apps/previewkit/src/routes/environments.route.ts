import type { AuthCaller, CallerAuthVariables } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { Hono } from "hono";
import { z } from "zod";
import type { GitProvider, PullRequestEvent } from "../git-provider/git-provider";
import { logger } from "../logger";
import type { PreviewPipeline } from "../pipeline/preview-pipeline";
import type { TeardownPipeline } from "../pipeline/teardown-pipeline";

export const MAIN_BRANCH_ENVIRONMENT_NUMBER = 0;

const deployRequestSchema = z.object({
    repoFullName: z.string().regex(/^[^/]+\/[^/]+$/, "must be 'owner/repo'"),
    prNumber: z.number().int().positive(),
    // Tenant + repo identity. The upstream API (which holds the GitHubInstallation
    // <-> Organization binding) resolves these from the webhook and forwards them
    // here, so Previewkit doesn't need a second lookup of its own.
    organizationId: z.string().min(1),
    githubRepositoryId: z.number().int().positive(),
    headSha: z.string().min(1),
    headRef: z.string().min(1),
    cloneUrl: z.string().url(),
    baseSha: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
});

interface EnvironmentsRouteDeps {
    previewPipeline: PreviewPipeline;
    teardownPipeline: TeardownPipeline;
    gitProvider: GitProvider;
}

export function createEnvironmentsRoute({ previewPipeline, teardownPipeline, gitProvider }: EnvironmentsRouteDeps) {
    return new Hono<{ Variables: CallerAuthVariables }>()
        .post("/environments", async (c) => {
            const body = await c.req.json().catch(() => undefined);
            const parsed = deployRequestSchema.safeParse(body);
            if (!parsed.success) {
                return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
            }

            const event: PullRequestEvent = {
                action: "opened",
                prNumber: parsed.data.prNumber,
                repoFullName: parsed.data.repoFullName,
                organizationId: parsed.data.organizationId,
                githubRepositoryId: parsed.data.githubRepositoryId,
                headSha: parsed.data.headSha,
                headRef: parsed.data.headRef,
                baseSha: parsed.data.baseSha ?? "",
                baseRef: parsed.data.baseRef ?? "",
                cloneUrl: parsed.data.cloneUrl,
            };

            previewPipeline.deploy(event).catch((err) => {
                logger.error("Deploy failed", err, { repo: event.repoFullName, pr: event.prNumber });
            });

            return c.json(
                {
                    accepted: true,
                    repoFullName: event.repoFullName,
                    prNumber: event.prNumber,
                    statusUrl: `/v1/environments/${event.repoFullName}/${event.prNumber}`,
                },
                202,
            );
        })

        .post("/applications/:applicationId/0", async (c) => {
            /**
             * Deploys the Application's main branch into environment 0.
             *
             * Normal preview environments use their GitHub PR number in the URL. Since
             * GitHub PR numbers start at 1, `/0` gives each Application a stable,
             * non-PR preview environment while keeping the environment-number route
             * convention intact.
             */
            const applicationId = c.req.param("applicationId");
            const orgId = callerOrgId(c.var.authCaller);

            const application = await db.application.findFirst({
                where: {
                    id: applicationId,
                    ...(orgId != null ? { organizationId: orgId } : {}),
                },
                select: {
                    id: true,
                    disabled: true,
                    organizationId: true,
                    githubRepositoryId: true,
                    mainBranch: { select: { name: true } },
                    mainBranchInfo: { select: { githubRef: true } },
                },
            });

            if (application == null) {
                return c.json({ error: "Application not found" }, 404);
            }

            if (application.disabled) {
                return c.json({ error: "Application is disabled and cannot be deployed" }, 409);
            }

            if (application.githubRepositoryId == null) {
                return c.json({ error: "Application is not linked to a GitHub repository" }, 409);
            }

            const installation = await db.gitHubInstallation.findUnique({
                where: { organizationId: application.organizationId },
                select: { installationId: true, status: true },
            });

            if (installation == null) {
                return c.json({ error: "Organization has no GitHub installation" }, 409);
            }

            if (installation.status !== "active") {
                return c.json({ error: `GitHub installation is ${installation.status}` }, 409);
            }

            const repo = await gitProvider
                .getRepository(installation.installationId, application.githubRepositoryId)
                .catch((err) => {
                    if (errorStatus(err) === 404) return undefined;
                    throw err;
                });
            if (repo == null) {
                return c.json({ error: "Linked GitHub repository not found or inaccessible" }, 404);
            }

            const mainRef = application.mainBranchInfo?.githubRef ?? application.mainBranch?.name ?? repo.defaultBranch;
            const branchName = normalizeBranchName(mainRef);
            const headSha = await gitProvider.getBranchHead(repo.fullName, branchName).catch((err) => {
                if (errorStatus(err) === 404) return undefined;
                throw err;
            });
            if (headSha == null) {
                return c.json({ error: `Main branch ref '${mainRef}' not found on GitHub` }, 404);
            }

            const event: PullRequestEvent = {
                action: "synchronize",
                prNumber: MAIN_BRANCH_ENVIRONMENT_NUMBER,
                repoFullName: repo.fullName,
                organizationId: application.organizationId,
                githubRepositoryId: application.githubRepositoryId,
                headSha,
                headRef: branchName,
                baseSha: headSha,
                baseRef: branchName,
                cloneUrl: `https://github.com/${repo.fullName}.git`,
            };

            previewPipeline.deploy(event).catch((err) => {
                logger.error("Main branch deploy failed", err, {
                    applicationId: application.id,
                    repo: event.repoFullName,
                    branch: branchName,
                });
            });

            return c.json(
                {
                    accepted: true,
                    applicationId: application.id,
                    repoFullName: event.repoFullName,
                    branch: branchName,
                    headSha,
                    prNumber: event.prNumber,
                    statusUrl: `/v1/environments/${event.repoFullName}/${event.prNumber}`,
                },
                202,
            );
        })

        .delete("/environments/:owner/:repo/:pr", async (c) => {
            const owner = c.req.param("owner");
            const repo = c.req.param("repo");
            const pr = parseEnvironmentNumber(c.req.param("pr"));
            if (pr == null) {
                return c.json({ error: "pr must be a non-negative integer" }, 400);
            }

            const organizationId = c.req.query("organizationId");
            if (organizationId == null || organizationId === "") {
                return c.json({ error: "organizationId query param is required" }, 400);
            }
            const githubRepositoryIdRaw = c.req.query("githubRepositoryId");
            const githubRepositoryId = githubRepositoryIdRaw != null ? Number(githubRepositoryIdRaw) : NaN;
            if (!Number.isInteger(githubRepositoryId) || githubRepositoryId <= 0) {
                return c.json({ error: "githubRepositoryId query param must be a positive integer" }, 400);
            }

            const repoFullName = `${owner}/${repo}`;
            const event: PullRequestEvent = {
                action: "closed",
                prNumber: pr,
                repoFullName,
                organizationId,
                githubRepositoryId,
                headSha: "",
                headRef: "",
                baseSha: "",
                baseRef: "",
                cloneUrl: "",
            };

            teardownPipeline.teardown(event).catch((err) => {
                logger.error("Teardown failed", err, { repo: repoFullName, pr });
            });

            return c.json({ accepted: true, repoFullName, prNumber: pr }, 202);
        })

        .post("/environments/:owner/:repo/:pr/redeploy", async (c) => {
            const owner = c.req.param("owner");
            const repo = c.req.param("repo");
            const pr = parseEnvironmentNumber(c.req.param("pr"));
            if (pr == null) {
                return c.json({ error: "pr must be a non-negative integer" }, 400);
            }

            const repoFullName = `${owner}/${repo}`;
            const env = await db.previewkitEnvironment.findUnique({
                where: { repoFullName_prNumber: { repoFullName, prNumber: pr } },
                select: {
                    headSha: true,
                    headRef: true,
                    organizationId: true,
                    githubRepositoryId: true,
                    status: true,
                    configRevisionId: true,
                },
            });

            if (env == null) {
                return c.json({ error: "Environment not found" }, 404);
            }

            if (env.status === "torn_down") {
                return c.json({ error: "Environment has been torn down and cannot be redeployed" }, 409);
            }

            if (env.githubRepositoryId == null) {
                return c.json({ error: "Environment predates redeploy support and cannot be redeployed" }, 409);
            }

            const event: PullRequestEvent = {
                action: "synchronize",
                prNumber: pr,
                repoFullName,
                organizationId: env.organizationId,
                githubRepositoryId: env.githubRepositoryId,
                headSha: env.headSha,
                headRef: env.headRef,
                baseSha: "",
                baseRef: "",
                cloneUrl: "",
            };

            // Pin the config revision this environment was originally deployed with so the
            // redeploy reproduces the same topology even if the Application's active config
            // changed since. Undefined (a .preview.yaml-sourced deploy) re-resolves normally.
            previewPipeline.deploy(event, { configRevisionId: env.configRevisionId ?? undefined }).catch((err) => {
                logger.error("Redeploy failed", err, { repo: repoFullName, pr });
            });

            return c.json({ accepted: true, repoFullName, prNumber: pr }, 202);
        });
}

function callerOrgId(caller: AuthCaller): string | undefined {
    return caller.kind === "user" ? caller.organizationId : undefined;
}

function parseEnvironmentNumber(raw: string): number | undefined {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return undefined;
    return value;
}

function normalizeBranchName(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function errorStatus(error: unknown): number | undefined {
    if (error instanceof Error && "status" in error) {
        const status = (error as { status?: unknown }).status;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}
