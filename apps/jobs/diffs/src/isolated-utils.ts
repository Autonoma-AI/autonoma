import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import type { ExistingTestInfo } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";

// ---- Test with steps --------------------------------------------------------

export interface TestStepData {
    interaction: string;
    params: Record<string, unknown>;
    waitCondition?: string;
}

/** An existing test that may include recorded steps for replay. */
export interface ExistingTestWithSteps extends ExistingTestInfo {
    steps?: TestStepData[];
}

export const execFileAsync = promisify(execFile);
export const DEFAULT_TESTS_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

// ---- CLI -------------------------------------------------------------------

export interface BaseCliArgs {
    repo: string;
    testsDir: string;
    branch?: string;
    base?: string;
    head?: string;
}

type ExtraOptions = Record<string, { type: "string" | "boolean" }>;

export function parseBaseCliArgs<T extends ExtraOptions>(
    extraOptions?: T,
): { base: BaseCliArgs; extra: Record<keyof T, string | boolean | undefined> } {
    const { values } = parseArgs({
        options: {
            repo: { type: "string" },
            "tests-dir": { type: "string" },
            branch: { type: "string" },
            base: { type: "string" },
            head: { type: "string" },
            ...extraOptions,
        },
        strict: true,
    });

    if (values.repo == null) {
        throw new Error("--repo is required");
    }

    const base: BaseCliArgs = {
        repo: values.repo,
        testsDir: values["tests-dir"] ?? DEFAULT_TESTS_DIR,
        branch: values.branch,
        base: values.base,
        head: values.head,
    };

    const extra: Record<string, string | boolean | undefined> = {};
    const valuesAny = values as Record<string, string | boolean | undefined>;
    for (const key of Object.keys(extraOptions ?? {})) {
        extra[key] = valuesAny[key];
    }

    return { base, extra: extra as Record<keyof T, string | boolean | undefined> };
}

// ---- Repository ------------------------------------------------------------

export function isRemoteUrl(value: string): boolean {
    return value.startsWith("https://") || value.startsWith("git@");
}

export async function cloneRepo(url: string, targetDir: string, branch?: string): Promise<void> {
    const logger = rootLogger.child({ name: "cloneRepo" });
    logger.info("Cloning repository", { url, branch });

    const branchArgs = branch != null ? ["--branch", branch] : [];
    await execFileAsync("git", ["clone", ...branchArgs, url, targetDir]);

    logger.info("Repository cloned", { targetDir });
}

export async function resolveCommits(
    repoDir: string,
    { branch, base, head }: Pick<BaseCliArgs, "branch" | "base" | "head">,
): Promise<{ baseSha: string; headSha: string }> {
    const logger = rootLogger.child({ name: "resolveCommits" });

    const revParse = async (ref: string) => {
        const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd: repoDir });
        return stdout.trim();
    };

    if (branch != null) {
        logger.info("Resolving commits from branch", { branch });
        const { stdout } = await execFileAsync("git", ["merge-base", "main", branch], { cwd: repoDir });
        const baseSha = stdout.trim();
        const headSha = await revParse(branch);
        logger.info("Resolved commits", { baseSha, headSha });
        return { baseSha, headSha };
    }

    const baseSha = await revParse(base ?? "HEAD~1");
    const headSha = await revParse(head ?? "HEAD");
    logger.info("Resolved commits", { baseSha, headSha });
    return { baseSha, headSha };
}

// ---- Repo setup ------------------------------------------------------------

export interface PreparedRepo {
    repoDir: string;
    tempDir?: string;
}

export async function prepareRepo(args: BaseCliArgs): Promise<PreparedRepo> {
    if (!isRemoteUrl(args.repo)) {
        if (args.branch != null) {
            await execFileAsync("git", ["checkout", args.branch], { cwd: args.repo });
        }
        return { repoDir: args.repo };
    }

    const tempDir = await mkdtemp(join(tmpdir(), "autonoma-diffs-"));
    await cloneRepo(args.repo, tempDir, args.branch);
    return { repoDir: tempDir, tempDir };
}

// ---- Tests directory -------------------------------------------------------

export async function readTestFiles(testsDir: string): Promise<ExistingTestWithSteps[]> {
    const dir = join(testsDir, "qa-tests");
    const files = await readdir(dir);
    const tests: ExistingTestWithSteps[] = [];

    for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const raw = await readFile(join(dir, file), "utf-8");
        const slug = file.replace(".md", "");
        const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
        const name = frontmatter?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim() ?? slug;
        const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

        // Load recorded steps from companion .steps.json if it exists
        let steps: TestStepData[] | undefined;
        try {
            const stepsRaw = await readFile(join(dir, `${slug}.steps.json`), "utf-8");
            steps = JSON.parse(stepsRaw) as TestStepData[];
        } catch {
            // No steps file - test can only be used for generation, not replay
        }

        tests.push({ id: `test-${slug}`, name, slug, prompt: body, steps });
    }

    return tests;
}
