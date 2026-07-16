/**
 * End-to-end SDK-integration eval for one repo:
 *
 *   checkout(sha) -> copy to sandbox -> apply strip.patch -> commit clean baseline
 *   -> drive `claude -p` over the sandbox (it starts the app locally itself)
 *   -> extract agent/golden diffs -> stage judge trees -> agentic judge -> verdict.json
 *
 *   pnpm --filter @autonoma-ai/planner eval:sdk -- --repo <name>
 *        [--model <bedrock-id>] [--judge-model <id>] [--timeout <min>] [--no-drive] [--no-judge]
 *
 * IMPORTANT: run with any host network sandbox DISABLED, or the Bedrock bearer
 * token 403s through the proxy.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureCachedCheckout } from "../framework/checkout";
import { driveClaude } from "../framework/drive-claude";
import { DEFAULT_AWS_REGION, readHarnessEnv } from "../framework/env";
import { commitAll, copyTree, git } from "../framework/git";
import { runDir as runDirFor } from "../framework/paths";
import { loadCase, type LoadedCase } from "./case";
import { judgeRun } from "./judge";
import { renderIntegrationPrompt } from "./prompt";
import { verdictSchema } from "./verdict";

const DEFAULT_DRIVE_MODEL = "us.anthropic.claude-opus-4-8";
const DEFAULT_TIMEOUT_MIN = 40;

interface Args {
    repo: string;
    model: string;
    judgeModel?: string;
    timeoutMin: number;
    noDrive: boolean;
    noJudge: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = {
        repo: "",
        model: DEFAULT_DRIVE_MODEL,
        timeoutMin: DEFAULT_TIMEOUT_MIN,
        noDrive: false,
        noJudge: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === "--repo") a.repo = argv[++i] ?? "";
        else if (v === "--model") a.model = argv[++i] ?? DEFAULT_DRIVE_MODEL;
        else if (v === "--judge-model") a.judgeModel = argv[++i];
        else if (v === "--timeout") a.timeoutMin = Number(argv[++i]);
        else if (v === "--no-drive") a.noDrive = true;
        else if (v === "--no-judge") a.noJudge = true;
    }
    if (!a.repo) throw new Error("--repo <name> is required");
    return a;
}

function log(msg: string): void {
    process.stdout.write(`\n=== ${msg} ===\n`);
}

/** Derive the clean sandbox from the pristine checkout without mutating the cache. */
async function prepareSandbox(kase: LoadedCase, cacheDir: string, sandbox: string): Promise<string> {
    log("copy checkout -> sandbox");
    await copyTree(cacheDir, sandbox);
    log("apply strip.patch (sha -> clean)");
    await git(sandbox, ["apply", "--whitespace=nowarn", kase.stripPatchPath]);
    const cleanSha = await commitAll(sandbox, "eval: clean baseline (SDK stripped)");
    return cleanSha;
}

/** Stage everything the judge reads under one root, so its tools see both trees + transcript. */
async function stageJudge(params: {
    judgeRoot: string;
    sandbox: string;
    cacheDir: string;
    runDir: string;
    artifactsDir: string;
}): Promise<void> {
    const { judgeRoot, sandbox, cacheDir, runDir, artifactsDir } = params;
    await copyTree(sandbox, join(judgeRoot, "agent"));
    await copyTree(cacheDir, join(judgeRoot, "golden"));
    await mkdir(join(judgeRoot, "spec"), { recursive: true });
    for (const [from, to] of [
        [join(runDir, "agent.diff"), join(judgeRoot, "agent.diff")],
        [join(runDir, "golden.diff"), join(judgeRoot, "golden.diff")],
        [join(runDir, "progress.log"), join(judgeRoot, "progress.log")],
        [join(runDir, "claude.stream.jsonl"), join(judgeRoot, "claude.stream.jsonl")],
        [join(artifactsDir, "entity-audit.md"), join(judgeRoot, "spec", "entity-audit.md")],
        [join(artifactsDir, "recipe.json"), join(judgeRoot, "spec", "recipe.json")],
    ] as const) {
        await copyFile(from, to).catch((err) => console.error(`[stage] skipped ${basename(from)}: ${err.message}`));
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const kase = loadCase(args.repo);
    const env = readHarnessEnv();

    // Fail fast before the (possibly slow) checkout + setup rather than after them.
    if (!args.noDrive && env.AWS_BEARER_TOKEN_BEDROCK == null) {
        throw new Error(
            "AWS_BEARER_TOKEN_BEDROCK is required for a drive; set it in your environment (or pass --no-drive).",
        );
    }

    const cacheDir = await ensureCachedCheckout(kase.coords);

    const stamp = String(Date.now());
    const runDir = runDirFor(args.repo, stamp);
    mkdirSync(runDir, { recursive: true });
    const sandbox = join(runDir, "sandbox");

    const cleanSha = await prepareSandbox(kase, cacheDir, sandbox);

    if (args.noDrive) {
        log(`clean sandbox prepared (--no-drive) at ${sandbox}`);
        return;
    }

    // Stage the frozen artifacts OUTSIDE the sandbox so the agent reads them without polluting its diff.
    const stagedArtifacts = join(runDir, "artifacts");
    await copyTree(kase.artifactsDir, stagedArtifacts);

    const sharedSecret = randomBytes(32).toString("hex");
    const runHome = join(runDir, "home");
    mkdirSync(runHome, { recursive: true });

    const prompt = renderIntegrationPrompt({
        sharedSecret,
        artifactsDir: stagedArtifacts,
    });

    const bedrockToken = env.AWS_BEARER_TOKEN_BEDROCK;
    if (bedrockToken == null) throw new Error("AWS_BEARER_TOKEN_BEDROCK is required for a drive.");
    log(`drive claude -p (model=${args.model}, timeout=${args.timeoutMin}m)`);
    const drive = await driveClaude({
        sandbox,
        readableDirs: [stagedArtifacts],
        runHome,
        prompt,
        model: args.model,
        bedrockToken,
        region: env.AWS_REGION ?? DEFAULT_AWS_REGION,
        appEnv: { AUTONOMA_SHARED_SECRET: sharedSecret },
        runDir,
        timeoutMs: args.timeoutMin > 0 ? args.timeoutMin * 60_000 : 0,
    });
    log(
        `drive finished (exit=${drive.exitCode ?? "?"}, timedOut=${drive.timedOut}, ${(drive.durationMs / 1000).toFixed(0)}s)`,
    );

    // The agent's additions diff against the clean baseline; golden's additions are clean -> sha.
    // Stage first so the agent's new (untracked) files - the endpoint, the factories - are in the diff.
    await git(sandbox, ["add", "-A"]);
    const agentDiff = await git(sandbox, ["diff", cleanSha]);
    const goldenDiff = await git(sandbox, ["diff", cleanSha, kase.coords.sha]);
    writeFileSync(join(runDir, "agent.diff"), agentDiff + "\n");
    writeFileSync(join(runDir, "golden.diff"), goldenDiff + "\n");

    if (args.noJudge) {
        log(`drive complete (--no-judge). diffs + transcript in ${runDir}`);
        return;
    }

    const judgeRoot = join(runDir, "judge");
    await stageJudge({ judgeRoot, sandbox, cacheDir, runDir, artifactsDir: kase.artifactsDir });

    log("judging");
    const verdict = await judgeRun({ judgeRoot, modelId: args.judgeModel });
    if (verdict == null) {
        throw new Error("Judge did not return a verdict; see the judge output above.");
    }
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(verdictSchema.parse(verdict), null, 2) + "\n");

    log(`verdict: ${verdict.passed ? "PASS" : "FAIL"}`);
    process.stdout.write(
        `factories: ${verdict.factoryCoverage.covered.length} covered, ${verdict.factoryCoverage.missing.length} missing` +
            `${verdict.factoryCoverage.missing.length ? ` (${verdict.factoryCoverage.missing.join(", ")})` : ""}\n`,
    );
    for (const [key, dim] of Object.entries(verdict.dimensions)) {
        process.stdout.write(`  ${dim.satisfied ? "✓" : "✗"} ${key}: ${dim.evidence}\n`);
    }
    process.stdout.write(`\n${verdict.reasoning}\n\nFull verdict: ${join(runDir, "verdict.json")}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
