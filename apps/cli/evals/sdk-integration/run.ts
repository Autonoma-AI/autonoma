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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { COMPLETION_MARKER_FILE } from "../../src/agents/04-recipe-builder/completion";
import { writeIntegrationPrompt } from "../../src/agents/04-recipe-builder/integration-prompt";
import { RECIPE_FILE } from "../../src/agents/04-recipe-builder/recipe";
import { type CheckoutCoords, ensureCachedCheckout } from "../framework/checkout";
import { stageContextCheckout } from "../framework/context-repos";
import { driveClaude } from "../framework/drive-claude";
import { DEFAULT_AWS_REGION, readHarnessEnv } from "../framework/env";
import { commitAll, copyTree, git } from "../framework/git";
import { EVALS_ROOT, runDir as runDirFor } from "../framework/paths";
import { loadCase, type LoadedCase } from "./case";
import { judgeRun } from "./judge";
import { verdictSchema } from "./verdict";

const DEFAULT_DRIVE_MODEL = "us.anthropic.claude-opus-4-8";
const DEFAULT_TIMEOUT_MIN = 40;
/** The built CLI the driven agent invokes as its endpoint tool (`<node> <this> sdk ...`). */
const CLI_DIST = join(EVALS_ROOT, "..", "dist", "index.js");

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

/**
 * Clone each read-only context repo and stage a copy outside the sandbox, so the
 * agent can read its polyrepo siblings without touching the pristine cache and
 * without the reads showing up in the target sandbox's diff. Each is stripped of the
 * SDK integration (via its context strip) exactly like the target. Returns the staged dirs.
 */
async function stageContextRepos(caseRepo: string, contextRepos: CheckoutCoords[], runDir: string): Promise<string[]> {
    return Promise.all(
        contextRepos.map(async (coords) => {
            const staged = join(runDir, "context", `${coords.owner}__${coords.repo}`);
            await stageContextCheckout(caseRepo, coords, staged);
            return staged;
        }),
    );
}

/** A read-only-sibling-repos note appended to the drive prompt, or "" for single-repo cases. */
function renderSiblingReposNote(contextRepoDirs: string[]): string {
    if (contextRepoDirs.length === 0) return "";
    const list = contextRepoDirs.map((dir) => `    ${dir}`).join("\n");
    return `

═══ SIBLING REPOS (read-only context) ═══
This app spans multiple repos. Your integration lands ONLY in the checkout you are
working in (the current directory); the models and creation paths you must mirror
may live in these sibling checkouts, provided READ-ONLY for reference:
${list}
Read them to understand the models, their real creation paths, and the invariants the
entity audit refers to. Do NOT edit anything under these directories - changes there
are neither graded nor kept; all your work goes in the target checkout.`;
}

/** Stage everything the judge reads under one root, so its tools see both trees + transcript. */
async function stageJudge(params: {
    judgeRoot: string;
    sandbox: string;
    cacheDir: string;
    runDir: string;
    artifactsDir: string;
    stagedArtifacts: string;
}): Promise<void> {
    const { judgeRoot, sandbox, cacheDir, runDir, artifactsDir, stagedArtifacts } = params;
    await copyTree(sandbox, join(judgeRoot, "agent"));
    await copyTree(cacheDir, join(judgeRoot, "golden"));
    await mkdir(join(judgeRoot, "spec"), { recursive: true });
    for (const [from, to] of [
        [join(runDir, "agent.diff"), join(judgeRoot, "agent.diff")],
        [join(runDir, "golden.diff"), join(judgeRoot, "golden.diff")],
        [join(runDir, "progress.log"), join(judgeRoot, "progress.log")],
        [join(runDir, "claude.stream.jsonl"), join(judgeRoot, "claude.stream.jsonl")],
        [join(artifactsDir, "entity-audit.md"), join(judgeRoot, "spec", "entity-audit.md")],
        [join(stagedArtifacts, RECIPE_FILE), join(judgeRoot, "spec", "recipe.agent.json")],
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
    // The agent validates by shelling out to the built CLI's `sdk` command, so it must exist.
    if (!args.noDrive && !existsSync(CLI_DIST)) {
        throw new Error(
            `The built CLI is required for the agent's \`sdk\` tool but is missing at ${CLI_DIST}. ` +
                `Build it first: \`pnpm --filter @autonoma-ai/planner build\` (or pass --no-drive).`,
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

    // Stage the frozen artifacts + read-only context repos OUTSIDE the sandbox so the agent
    // reads them without polluting its diff (or mutating the shared cache).
    const stagedArtifacts = join(runDir, "artifacts");
    const [, contextRepoDirs] = await Promise.all([
        copyTree(kase.artifactsDir, stagedArtifacts),
        stageContextRepos(kase.repo, kase.contextRepos, runDir),
    ]);
    // The agent GENERATES the recipe in this flow; drop the frozen one so it can't read/edit a
    // pre-made answer. The frozen recipe stays available to the judge from the case dir.
    await rm(join(stagedArtifacts, RECIPE_FILE), { force: true });

    const sharedSecret = randomBytes(32).toString("hex");
    const runHome = join(runDir, "home");
    mkdirSync(runHome, { recursive: true });

    // Render the CLI's own integration prompt (single source of truth) and hand the agent the
    // built CLI as its `sdk` endpoint tool. The shared secret rides the env (appEnv below).
    const cliCommand = `${process.execPath} ${CLI_DIST}`;
    const promptFile = await writeIntegrationPrompt({
        outputDir: stagedArtifacts,
        recipePath: join(stagedArtifacts, RECIPE_FILE),
        cliCommand,
    });
    // Extra directives to the driven agent live here, in the harness's own drive prompt - NOT in
    // the framework-agnostic integration prompt (which must stay free of any eval/project
    // specifics) and NOT in ENV.md (human-only, never fed to the agent). Two optional sources:
    // per-case `agent-notes.md` (repo-specific, committed) and an operator secrets file.
    const secretsFile = env.SDK_EVAL_SECRETS_FILE;
    const bootSecretsNote =
        secretsFile != null
            ? `\n\nBOOT CREDENTIALS: the real environment this app needs to run locally - including ` +
              `any hosted external-service credentials that cannot be mocked - is in the file ` +
              `${secretsFile}. Read it and use those values when you bring the app up (put them wherever ` +
              `this stack loads env from). Do not commit it. Do not set AUTONOMA_SHARED_SECRET from it - ` +
              `that is already provisioned in the environment.`
            : "";
    const caseNotes =
        kase.agentNotes != null
            ? `\n\nCASE-SPECIFIC INSTRUCTIONS for this app (follow them exactly):\n${kase.agentNotes}`
            : "";
    const prompt =
        `Read the file ${promptFile} and follow its instructions exactly to integrate ` +
        `Autonoma into this application. It is your complete spec. Do not stop until every ` +
        `item in it is done and you have written the completion marker it describes.` +
        caseNotes +
        bootSecretsNote +
        renderSiblingReposNote(contextRepoDirs);

    // Read-only dirs for the agent, all OUTSIDE the sandbox so they never enter its diff: the
    // staged artifacts, the polyrepo sibling checkouts, and (if set) the operator secrets file's dir.
    const readableDirs = [stagedArtifacts, ...contextRepoDirs];
    if (secretsFile != null) readableDirs.push(dirname(secretsFile));

    const bedrockToken = env.AWS_BEARER_TOKEN_BEDROCK;
    if (bedrockToken == null) throw new Error("AWS_BEARER_TOKEN_BEDROCK is required for a drive.");
    log(`drive claude -p (model=${args.model}, timeout=${args.timeoutMin}m)`);
    const drive = await driveClaude({
        sandbox,
        readableDirs,
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

    // Deterministic signals of the new shape: did the agent generate a recipe and report done?
    const recipeGenerated = existsSync(join(stagedArtifacts, RECIPE_FILE));
    const completionMarkerWritten = existsSync(join(stagedArtifacts, COMPLETION_MARKER_FILE));
    log(`recipe generated: ${recipeGenerated} · completion marker: ${completionMarkerWritten}`);

    if (args.noJudge) {
        log(`drive complete (--no-judge). diffs + transcript in ${runDir}`);
        return;
    }

    const judgeRoot = join(runDir, "judge");
    await stageJudge({ judgeRoot, sandbox, cacheDir, runDir, artifactsDir: kase.artifactsDir, stagedArtifacts });

    log("judging");
    const verdict = await judgeRun({ judgeRoot, modelId: args.judgeModel });
    if (verdict == null) {
        throw new Error("Judge did not return a verdict; see the judge output above.");
    }
    const finalVerdict = { ...verdictSchema.parse(verdict), recipeGenerated, completionMarkerWritten };
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(finalVerdict, null, 2) + "\n");

    log(`verdict: ${verdict.passed ? "PASS" : "FAIL"}`);
    process.stdout.write(
        `factories: ${verdict.factoryCoverage.covered.length} covered, ${verdict.factoryCoverage.missing.length} missing` +
            `${verdict.factoryCoverage.missing.length ? ` (${verdict.factoryCoverage.missing.join(", ")})` : ""}\n`,
    );
    process.stdout.write(`recipe generated: ${recipeGenerated} · completion marker: ${completionMarkerWritten}\n`);
    for (const [key, dim] of Object.entries(verdict.dimensions)) {
        process.stdout.write(`  ${dim.satisfied ? "✓" : "✗"} ${key}: ${dim.evidence}\n`);
    }
    process.stdout.write(`\n${verdict.reasoning}\n\nFull verdict: ${join(runDir, "verdict.json")}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
