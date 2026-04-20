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

            const repoFullName = `${owner}/${repo}`;
            const event: PullRequestEvent = {
                action: "closed",
                prNumber: pr,
                repoFullName,
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
        });
}
