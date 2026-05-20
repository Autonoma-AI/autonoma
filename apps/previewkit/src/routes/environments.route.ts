import { db } from "@autonoma/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Deployer } from "../deployer/deployer";
import type { PullRequestEvent } from "../git-provider/git-provider";
import { logger } from "../logger";
import type { PreviewPipeline } from "../pipeline/preview-pipeline";
import type { TeardownPipeline } from "../pipeline/teardown-pipeline";

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
    deployer: Deployer;
}

export function createEnvironmentsRoute({ previewPipeline, teardownPipeline, deployer }: EnvironmentsRouteDeps) {
    return new Hono()
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

        .get("/environments/:owner/:repo/:pr", async (c) => {
            const owner = c.req.param("owner");
            const repo = c.req.param("repo");
            const pr = Number(c.req.param("pr"));
            if (!Number.isInteger(pr) || pr <= 0) {
                return c.json({ error: "pr must be a positive integer" }, 400);
            }

            const repoFullName = `${owner}/${repo}`;
            const annotations = await deployer.getNamespaceAnnotations(repoFullName, pr);
            if (!annotations) {
                return c.json({ error: "Environment not found" }, 404);
            }

            return c.json({
                repoFullName,
                prNumber: pr,
                status: annotations.status ?? "unknown",
                phase: annotations.phase,
                createdAt: annotations.createdAt,
                updatedAt: annotations.updatedAt,
                lastDeployedSha: annotations.lastDeployedSha,
                urls: annotations.urls ?? {},
                error: annotations.error,
            });
        })

        .delete("/environments/:owner/:repo/:pr", async (c) => {
            const owner = c.req.param("owner");
            const repo = c.req.param("repo");
            const pr = Number(c.req.param("pr"));
            if (!Number.isInteger(pr) || pr <= 0) {
                return c.json({ error: "pr must be a positive integer" }, 400);
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
            const pr = Number(c.req.param("pr"));
            if (!Number.isInteger(pr) || pr <= 0) {
                return c.json({ error: "pr must be a positive integer" }, 400);
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

            previewPipeline.deploy(event).catch((err) => {
                logger.error("Redeploy failed", err, { repo: repoFullName, pr });
            });

            return c.json({ accepted: true, repoFullName, prNumber: pr }, 202);
        });
}
