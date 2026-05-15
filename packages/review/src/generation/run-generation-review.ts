import { MODEL_ENTRIES, ModelRegistry, VideoProcessor } from "@autonoma/ai";
import { env as aiEnv } from "@autonoma/ai/env";
import { Codebase } from "@autonoma/codebase";
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
import { GenerationContextLoader } from "./context-loader";
import { GenerationReviewer } from "./generation-reviewer";

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

const generationIdArg = process.argv[2];
if (generationIdArg == null) {
    console.error("Usage: review:generation <generationId>");
    process.exit(1);
}
const generationId: string = generationIdArg;

logger.info("Local generation reviewer (read-only - no DB writes)");

const storage = S3Storage.createFromEnv();
const contextLoader = new GenerationContextLoader(db, storage);

const registry = new ModelRegistry({
    models: { GEMINI_3_FLASH_PREVIEW: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
});
const model = registry.getModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "analysis" });
const videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" }));

const codebase = await cloneCodebase();

try {
    const context = await contextLoader.load(generationId);
    const reviewer = new GenerationReviewer({
        model,
        evidenceLoader: contextLoader,
        videoProcessor,
        codebase,
    });
    const { verdict } = await reviewer.review(context);

    if (verdict == null) {
        logger.warn("No verdict produced - the agent reached its step limit without submitting one");
        process.exit(0);
    }

    printVerdict(verdict);
    process.exit(0);
} catch (error) {
    logger.fatal("Local generation reviewer failed", error);
    process.exit(1);
} finally {
    await codebase.dispose();
}

async function cloneCodebase(): Promise<Codebase> {
    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: generationId },
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
    });
    const { headSha } = generation.snapshot;
    const { organizationId, githubRepositoryId } = generation.snapshot.branch.application;
    if (headSha == null) throw new Error(`Generation ${generationId} snapshot has no headSha`);
    if (githubRepositoryId == null) {
        throw new Error(`Generation ${generationId} application has no githubRepositoryId`);
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

    return Codebase.clone(githubClient, `/tmp/codebase/cli-gen-${generationId}`, {
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
    process.stdout.write("GenerationReview (local, read-only)\n");
    process.stdout.write(`${"=".repeat(60)}\n`);
    process.stdout.write(`Verdict:    ${verdict.verdict}\n`);
    process.stdout.write(`Confidence: ${verdict.confidence}\n`);
    process.stdout.write(`Severity:   ${verdict.severity}\n`);
    process.stdout.write(`Title:      ${verdict.title}\n\n`);
    process.stdout.write(`Reasoning:\n${verdict.reasoning}\n`);
    process.stdout.write(`${"=".repeat(60)}\n\n`);
}
