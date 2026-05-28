import { MODEL_ENTRIES, ModelRegistry, VideoProcessor } from "@autonoma/ai";
import { env as aiEnv } from "@autonoma/ai/env";
import { db } from "@autonoma/db";
import { OctokitGitHubApp } from "@autonoma/github";
import { base64PrivateKey } from "@autonoma/github/schemas";
import { logger } from "@autonoma/logger";
import { env as loggerEnv } from "@autonoma/logger/env";
import { S3Storage } from "@autonoma/storage";
import { env as storageEnv } from "@autonoma/storage/env";
import { GoogleGenAI } from "@google/genai";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { ReplayReviewer } from "../../agents/reviewers/replay/replay-reviewer";
import { Codebase } from "../../codebase";
import { RunContextLoader } from "./context-loader";

const env = createEnv({
    extends: [loggerEnv, storageEnv, aiEnv],
    server: {
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_APP_PRIVATE_KEY: base64PrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
        GITHUB_APP_SLUG: z.string().min(1),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});

const runIdArg = process.argv[2];
if (runIdArg == null) {
    console.error("Usage: review:replay <runId>");
    process.exit(1);
}
const runId: string = runIdArg;

logger.info("Local replay reviewer (read-only - no DB writes)");

const run = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
});

if (run.status !== "failed") {
    logger.info("Run is not failed - replay reviewer is failure-only", { runId, status: run.status });
    process.exit(0);
}

const storage = S3Storage.createFromEnv();
const contextLoader = new RunContextLoader(db, storage);

const registry = new ModelRegistry({
    models: { GEMINI_3_FLASH_PREVIEW: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
});
const model = registry.getModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "analysis" });
const videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" }));

const codebase = await cloneCodebase();

try {
    const context = await contextLoader.load(runId);
    const reviewer = new ReplayReviewer({
        model,
        evidenceLoader: contextLoader,
        videoProcessor,
    });
    try {
        const { result: verdict } = await reviewer.run({ context, codebase });
        printVerdict(verdict);
        process.exit(0);
    } catch (err) {
        logger.warn("No verdict produced - the agent reached its step limit without submitting one", {
            error: err instanceof Error ? err.message : String(err),
        });
        process.exit(0);
    }
} catch (error) {
    logger.fatal("Local replay reviewer failed", error);
    process.exit(1);
} finally {
    await codebase.dispose();
}

async function cloneCodebase(): Promise<Codebase> {
    const dbRun = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
            assignment: {
                select: {
                    snapshot: {
                        select: {
                            headSha: true,
                            branch: {
                                select: {
                                    application: {
                                        select: { organizationId: true, githubRepositoryId: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    const { headSha } = dbRun.assignment.snapshot;
    const { organizationId, githubRepositoryId } = dbRun.assignment.snapshot.branch.application;
    if (headSha == null) throw new Error(`Run ${runId} snapshot has no headSha`);
    if (githubRepositoryId == null) {
        throw new Error(`Run ${runId} application has no githubRepositoryId`);
    }

    const installation = await db.gitHubInstallation.findUniqueOrThrow({ where: { organizationId } });

    const githubApp = new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });
    const githubClient = await githubApp.getInstallationClient(installation.installationId);
    const repo = await githubClient.getRepository(githubRepositoryId);

    return Codebase.clone(githubClient, `/tmp/codebase/cli-run-${runId}`, {
        repoName: repo.fullName,
        commitSha: headSha,
    });
}

function printVerdict(verdict: {
    verdict: string;
    reasoning: string;
    title: string;
    confidence: number;
    severity: string;
}) {
    process.stdout.write(`\n${"=".repeat(60)}\n`);
    process.stdout.write("RunReview (local, read-only)\n");
    process.stdout.write(`${"=".repeat(60)}\n`);
    process.stdout.write(`Verdict:    ${verdict.verdict}\n`);
    process.stdout.write(`Confidence: ${verdict.confidence}\n`);
    process.stdout.write(`Severity:   ${verdict.severity}\n`);
    process.stdout.write(`Title:      ${verdict.title}\n\n`);
    process.stdout.write(`Reasoning:\n${verdict.reasoning}\n`);
    process.stdout.write(`${"=".repeat(60)}\n\n`);
}
