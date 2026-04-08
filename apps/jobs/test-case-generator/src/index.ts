import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@autonoma/db";
import { GitHubApp, type GitHubInstallationClient } from "@autonoma/github";
import { logger, runWithSentry } from "@autonoma/logger";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { ArgoGenerationProvider } from "@autonoma/test-updates/argo";
import * as Sentry from "@sentry/node";
import { env } from "./env";
import { isTextFile } from "./is-text-file";
import { runPhase } from "./run-phase";

const REPO_DIR = "/tmp/repo";
const QA_TESTS_DIR = path.join(REPO_DIR, "qa-tests");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "../prompts");

const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500 KB

async function main(): Promise<void> {
    const { REPOSITORY_ID } = env;

    Sentry.setTag("repositoryId", REPOSITORY_ID);

    const repo = await db.gitHubRepository.findUniqueOrThrow({
        where: { id: REPOSITORY_ID },
        select: {
            fullName: true,
            defaultBranch: true,
            application: { select: { mainBranchId: true } },
            installation: {
                select: {
                    installationId: true,
                    organizationId: true,
                },
            },
        },
    });

    if (repo.application == null) throw new Error(`Repository ${REPOSITORY_ID} has no linked application`);

    if (repo.application.mainBranchId == null) throw new Error(`Repository ${REPOSITORY_ID} has no main branch`);

    const client = await githubApp.getInstallationClient(repo.installation.installationId);

    await db.gitHubRepository.update({
        where: { id: REPOSITORY_ID },
        data: { generationStatus: "running" },
    });

    try {
        await generateTestCases(
            REPOSITORY_ID,
            client,
            repo.fullName,
            repo.defaultBranch,
            repo.application.mainBranchId,
            repo.installation.organizationId,
        );
    } catch (error) {
        logger.fatal("Test case generator failed", error);
        await db.gitHubRepository
            .update({
                where: { id: REPOSITORY_ID },
                data: { generationStatus: "failed" },
            })
            .catch(() => undefined);
        throw error;
    }
}

const githubApp = new GitHubApp({
    appSlug: env.GITHUB_APP_SLUG,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
});

async function generateTestCases(
    repositoryId: string,
    client: GitHubInstallationClient,
    repoFullName: string,
    defaultBranch: string,
    branchId: string,
    organizationId: string,
): Promise<void> {
    const jobLogger = logger.child({ repositoryId, repoFullName });

    await fetchRepoFiles(client, repoFullName, defaultBranch, jobLogger);

    const prompt000 = readFileSync(path.join(PROMPTS_DIR, "000-generate-autonoma-knowledge-base.md"), "utf-8");
    const prompt001 = readFileSync(path.join(PROMPTS_DIR, "001-generate-scenarios.md"), "utf-8");
    const prompt002 = readFileSync(path.join(PROMPTS_DIR, "002-generate-e2e-tests.md"), "utf-8");

    jobLogger.info("Starting phase 1: KB generation");
    Sentry.addBreadcrumb({
        message: "Starting phase 1: KB generation",
        level: "info",
    });
    let phaseStart = Date.now();
    await runPhase(prompt000, jobLogger.child({ phase: 1 }));
    jobLogger.info("Phase 1 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Starting phase 2: scenario generation");
    Sentry.addBreadcrumb({
        message: "Starting phase 2: scenario generation",
        level: "info",
    });
    phaseStart = Date.now();
    await runPhase(prompt001, jobLogger.child({ phase: 2 }));
    jobLogger.info("Phase 2 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Starting phase 3: E2E test generation");
    Sentry.addBreadcrumb({
        message: "Starting phase 3: E2E test generation",
        level: "info",
    });
    phaseStart = Date.now();
    await runPhase(prompt002, jobLogger.child({ phase: 3 }));
    jobLogger.info("Phase 3 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Saving test cases to database");
    Sentry.addBreadcrumb({
        message: "Saving test cases to database",
        level: "info",
    });
    const count = await saveTestCases(branchId, organizationId, jobLogger);

    await db.gitHubRepository.update({
        where: { id: repositoryId },
        data: { generationStatus: "completed" },
    });

    jobLogger.info("Test case generation complete", { testCaseCount: count });
}

async function fetchRepoFiles(
    client: GitHubInstallationClient,
    repoFullName: string,
    defaultBranch: string,
    jobLogger: ReturnType<typeof logger.child>,
): Promise<void> {
    mkdirSync(REPO_DIR, { recursive: true });

    const [owner, repoName] = repoFullName.split("/");
    if (owner == null || repoName == null) throw new Error(`Invalid REPO_FULL_NAME: ${repoFullName}`);

    const tree = await client.getTree(owner, repoName, defaultBranch, true);

    const blobs = tree.filter((item) => item.type === "blob" && item.path != null);
    const textBlobs = blobs.filter(
        (item) => item.path != null && isTextFile(item.path) && (item.size ?? 0) <= MAX_FILE_SIZE_BYTES,
    );
    const skipped = blobs.length - textBlobs.length;

    jobLogger.info("Fetching files from GitHub", {
        total: textBlobs.length,
        skipped,
    });

    let fetched = 0;
    let failed = 0;
    const startTime = Date.now();

    for (const item of textBlobs) {
        if (item.path == null) continue;

        try {
            const file = await client.getContent(owner, repoName, item.path, defaultBranch);
            const content = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8");
            const filePath = path.join(REPO_DIR, item.path);
            mkdirSync(path.dirname(filePath), { recursive: true });
            writeFileSync(filePath, content, "utf-8");
            fetched++;

            if (fetched % 100 === 0) {
                jobLogger.info("File fetch progress", {
                    fetched,
                    total: textBlobs.length,
                    failed,
                    durationMs: Date.now() - startTime,
                });
            }
        } catch (err) {
            jobLogger.warn("Failed to fetch file", { path: item.path, err });
            failed++;
        }
    }

    jobLogger.info("File fetch complete", {
        fetched,
        failed,
        durationMs: Date.now() - startTime,
    });
}

function collectMarkdownFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectMarkdownFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md") {
            files.push(fullPath);
        }
    }

    return files;
}

function parseTestCaseName(content: string): string {
    const match = content.match(/^# Test: (.+)/m);
    return match?.[1]?.trim() ?? "Untitled";
}

async function saveTestCases(
    branchId: string,
    organizationId: string,
    jobLogger: ReturnType<typeof logger.child>,
): Promise<number> {
    let filePaths: string[];
    try {
        filePaths = collectMarkdownFiles(QA_TESTS_DIR);
    } catch {
        jobLogger.info("No qa-tests directory found, skipping test case import");
        return 0;
    }

    const items: { name: string; content: string }[] = [];

    for (const filePath of filePaths) {
        const content = readFileSync(filePath, "utf-8");
        const name = parseTestCaseName(content);
        items.push({ name, content });
    }

    const jobProvider = new ArgoGenerationProvider({
        agentVersion: env.AGENT_VERSION,
    });
    const updater = await TestSuiteUpdater.startUpdate({
        db,
        branchId,
        jobProvider,
        organizationId,
    });

    for (const { name, content } of items) {
        await updater.apply(new AddTest({ name, plan: content }));
    }

    await updater.queuePendingGenerations({ autoActivate: true });

    jobLogger.info("Saved test cases to database", { count: items.length });
    return items.length;
}

await runWithSentry({ name: "test-case-generator", tags: { repositoryId: env.REPOSITORY_ID } }, () => main());
