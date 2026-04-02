import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@autonoma/db";
import { logger, runWithSentry } from "@autonoma/logger";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { ArgoGenerationProvider } from "@autonoma/test-updates/argo";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
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
            applicationId: true,
            application: { select: { mainBranchId: true } },
            installation: {
                select: {
                    installationId: true,
                    organizationId: true,
                },
            },
        },
    });

    if (repo.applicationId == null) throw new Error(`Repository ${REPOSITORY_ID} has no linked application`);

    const mainBranchId = repo.application?.mainBranchId;
    if (mainBranchId == null) throw new Error(`Application for repository ${REPOSITORY_ID} has no main branch`);

    const githubToken = await resolveInstallationToken(repo.installation.installationId);

    await db.gitHubRepository.update({
        where: { id: REPOSITORY_ID },
        data: { generationStatus: "running" },
    });

    try {
        await generateTestCases(
            REPOSITORY_ID,
            githubToken,
            repo.fullName,
            repo.defaultBranch,
            mainBranchId,
            repo.installation.organizationId,
        );
    } catch (error) {
        logger.fatal("Test case generator failed", error);
        await db.gitHubRepository
            .update({ where: { id: REPOSITORY_ID }, data: { generationStatus: "failed" } })
            .catch(() => undefined);
        throw error;
    }
}

async function resolveInstallationToken(installationId: number): Promise<string> {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    if (appId == null || privateKey == null || webhookSecret == null) {
        throw new Error(
            "Missing GitHub App credentials: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET",
        );
    }

    const app = new App({ appId, privateKey, webhooks: { secret: webhookSecret } });
    const octokit = await app.getInstallationOctokit(installationId);
    const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
    return token;
}

async function generateTestCases(
    repositoryId: string,
    githubToken: string,
    repoFullName: string,
    defaultBranch: string,
    branchId: string,
    organizationId: string,
): Promise<void> {
    const jobLogger = logger.child({ repositoryId, repoFullName });

    await fetchRepoFiles(githubToken, repoFullName, defaultBranch, jobLogger);

    const prompt000 = readFileSync(path.join(PROMPTS_DIR, "000-generate-autonoma-knowledge-base.md"), "utf-8");
    const prompt001 = readFileSync(path.join(PROMPTS_DIR, "001-generate-scenarios.md"), "utf-8");
    const prompt002 = readFileSync(path.join(PROMPTS_DIR, "002-generate-e2e-tests.md"), "utf-8");

    jobLogger.info("Starting phase 1: KB generation");
    Sentry.addBreadcrumb({ message: "Starting phase 1: KB generation", level: "info" });
    let phaseStart = Date.now();
    await runPhase(prompt000, jobLogger.child({ phase: 1 }));
    jobLogger.info("Phase 1 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Starting phase 2: scenario generation");
    Sentry.addBreadcrumb({ message: "Starting phase 2: scenario generation", level: "info" });
    phaseStart = Date.now();
    await runPhase(prompt001, jobLogger.child({ phase: 2 }));
    jobLogger.info("Phase 2 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Starting phase 3: E2E test generation");
    Sentry.addBreadcrumb({ message: "Starting phase 3: E2E test generation", level: "info" });
    phaseStart = Date.now();
    await runPhase(prompt002, jobLogger.child({ phase: 3 }));
    jobLogger.info("Phase 3 complete", { durationMs: Date.now() - phaseStart });

    jobLogger.info("Saving test cases to database");
    Sentry.addBreadcrumb({ message: "Saving test cases to database", level: "info" });
    const count = await saveTestCases(branchId, organizationId, jobLogger);

    await db.gitHubRepository.update({
        where: { id: repositoryId },
        data: { generationStatus: "completed" },
    });

    jobLogger.info("Test case generation complete", { testCaseCount: count });
}

async function fetchRepoFiles(
    githubToken: string,
    repoFullName: string,
    defaultBranch: string,
    jobLogger: ReturnType<typeof logger.child>,
): Promise<void> {
    mkdirSync(REPO_DIR, { recursive: true });

    const [owner, repoName] = repoFullName.split("/");
    if (owner == null || repoName == null) throw new Error(`Invalid REPO_FULL_NAME: ${repoFullName}`);

    const octokit = new Octokit({ auth: githubToken });

    const { data: tree } = await octokit.git.getTree({
        owner,
        repo: repoName,
        tree_sha: defaultBranch,
        recursive: "1",
    });

    const blobs = tree.tree.filter((item) => item.type === "blob" && item.path != null);
    const textBlobs = blobs.filter(
        (item) => item.path != null && isTextFile(item.path) && (item.size ?? 0) <= MAX_FILE_SIZE_BYTES,
    );
    const skipped = blobs.length - textBlobs.length;

    jobLogger.info("Fetching files from GitHub", { total: textBlobs.length, skipped });

    let fetched = 0;
    let failed = 0;
    const startTime = Date.now();

    for (const item of textBlobs) {
        if (item.path == null) continue;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo: repoName,
                path: item.path,
                ref: defaultBranch,
            });

            if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
                failed++;
                continue;
            }

            const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
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

    jobLogger.info("File fetch complete", { fetched, failed, durationMs: Date.now() - startTime });
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

    const jobProvider = new ArgoGenerationProvider({ agentVersion: env.AGENT_VERSION });
    const updater = await TestSuiteUpdater.startUpdate({ db, branchId, jobProvider, organizationId });

    for (const { name, content } of items) {
        await updater.apply(new AddTest({ name, plan: content }));
    }

    await updater.queuePendingGenerations({ autoActivate: true });

    jobLogger.info("Saved test cases to database", { count: items.length });
    return items.length;
}

await runWithSentry({ name: "test-case-generator", tags: { repositoryId: env.REPOSITORY_ID } }, () => main());
