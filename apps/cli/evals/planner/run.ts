/**
 * Layer-1 planner-step eval for one repo:
 *
 *   checkout(sha) -> copy to sandbox -> apply strip.patch (clean) -> seed the frozen
 *   UPSTREAM artifacts + project context -> run ONE planner step via the real CLI
 *   -> judge the produced artifact against its findings rubric -> [--promote it back]
 *
 *   pnpm --filter @autonoma-ai/planner eval:planner -- --repo <name> --step <kb|entityAudit|
 *        scenarioRecipe|recipeBuilder> [--model <id>] [--judge-model <id>] [--promote] [--timeout <min>]
 *
 * `--promote` copies the produced artifact back into cases/<repo>/artifacts/, so running the
 * steps in order bootstraps the whole frozen artifact set that Layer 2 consumes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { copyFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { ensureCachedCheckout } from "../framework/checkout";
import { contextPath, loadCoords, rubricPath } from "../framework/corpus";
import { copyTree, git } from "../framework/git";
import { artifactsDir, caseDir, runDir as runDirFor } from "../framework/paths";
import { runPlanner } from "../framework/run-planner-step";
import { judgePlannerArtifact, plannerVerdictSchema } from "./judge";
import { isPlannerStep, PLANNER_STEPS, readArtifact } from "./steps";

const OUTPUT_SLUG = "eval";
const DEFAULT_TIMEOUT_MIN = 30;

interface Args {
    repo: string;
    step: string;
    model?: string;
    judgeModel?: string;
    promote: boolean;
    timeoutMin: number;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { repo: "", step: "", promote: false, timeoutMin: DEFAULT_TIMEOUT_MIN };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === "--repo") a.repo = argv[++i] ?? "";
        else if (v === "--step") a.step = argv[++i] ?? "";
        else if (v === "--model") a.model = argv[++i];
        else if (v === "--judge-model") a.judgeModel = argv[++i];
        else if (v === "--promote") a.promote = true;
        else if (v === "--timeout") a.timeoutMin = Number(argv[++i]);
    }
    if (!a.repo) throw new Error("--repo <name> is required");
    if (!isPlannerStep(a.step)) {
        throw new Error(`--step must be one of: ${Object.keys(PLANNER_STEPS).join(", ")}`);
    }
    return a;
}

function log(msg: string): void {
    process.stdout.write(`\n=== ${msg} ===\n`);
}

/** Seed the output dir with the frozen upstream artifacts (everything in artifacts/ except the step's own outputs). */
async function seedUpstream(artifacts: string, outputDir: string, ownOutputs: string[]): Promise<void> {
    const exclude = new Set(ownOutputs);
    for (const name of readdirSync(artifacts)) {
        if (exclude.has(name)) continue;
        await cp(join(artifacts, name), join(outputDir, name), { recursive: true });
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const step = PLANNER_STEPS[args.step]!;
    const coords = loadCoords(args.repo);

    const ctxPath = contextPath(args.repo);
    if (!existsSync(ctxPath)) {
        throw new Error(
            `Case "${args.repo}" is missing context.json (required for a non-interactive planner run) at ${ctxPath}.`,
        );
    }
    const apiToken = process.env.AUTONOMA_API_TOKEN?.trim();
    if (apiToken == null || apiToken === "") {
        throw new Error("AUTONOMA_API_TOKEN is required (the planner runs its models through the managed proxy).");
    }

    const artifacts = artifactsDir(args.repo);
    if (!existsSync(artifacts)) mkdirSync(artifacts, { recursive: true });

    const cacheDir = await ensureCachedCheckout(coords);

    const stamp = String(Date.now());
    const runDir = runDirFor(args.repo, `planner-${args.step}-${stamp}`);
    mkdirSync(runDir, { recursive: true });
    const sandbox = join(runDir, "sandbox");

    log("copy checkout -> sandbox, apply strip.patch (clean)");
    await copyTree(cacheDir, sandbox);
    await git(sandbox, ["apply", "--whitespace=nowarn", join(caseDir(args.repo), "strip.patch")]);

    const home = join(runDir, "home");
    const outputDir = join(home, ".autonoma", OUTPUT_SLUG);
    mkdirSync(outputDir, { recursive: true });
    await copyFile(ctxPath, join(outputDir, ".project-context.json"));
    await seedUpstream(artifacts, outputDir, step.outputs);

    log(`run planner step "${args.step}" (timeout ${args.timeoutMin}m)`);
    const run = await runPlanner({
        step: step.flag,
        label: step.flag,
        projectRoot: sandbox,
        home,
        slug: OUTPUT_SLUG,
        apiToken,
        apiUrl: process.env.AUTONOMA_API_URL,
        model: args.model,
        runDir,
        timeoutMs: args.timeoutMin > 0 ? args.timeoutMin * 60_000 : 0,
    });
    log(
        `step finished (exit=${run.exitCode ?? "?"}, timedOut=${run.timedOut}, ${(run.durationMs / 1000).toFixed(0)}s)`,
    );

    if (run.exitCode !== 0 || run.timedOut) {
        throw new Error(
            `The planner step "${args.step}" itself failed (exit=${run.exitCode ?? "?"}, timedOut=${run.timedOut}) - ` +
                `not the rubric or judge. See ${run.logPath}. Planner steps can fail transiently (provider errors); re-run.`,
        );
    }

    const artifact = readArtifact(outputDir, step.primary);

    if (args.promote) {
        const dest = join(artifacts, step.primary);
        await cp(join(outputDir, step.primary), dest, { recursive: true });
        log(`promoted ${step.primary} -> ${dest}`);
    }

    const rPath = rubricPath(args.repo, args.step);
    if (!existsSync(rPath)) {
        log(`no rubric at ${rPath}; skipping judge${args.promote ? " (artifact promoted)" : ""}`);
        return;
    }

    log("judging against findings rubric");
    const verdict = await judgePlannerArtifact({
        step: args.step,
        artifact,
        rubric: readFileSync(rPath, "utf-8"),
        modelId: args.judgeModel,
    });
    if (verdict == null) throw new Error("Judge did not return a verdict; see the output above.");

    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(plannerVerdictSchema.parse(verdict), null, 2) + "\n");
    log(`verdict: ${verdict.passed ? "PASS" : "FAIL"}`);
    process.stdout.write(`\n${verdict.reasoning}\n\nFull verdict: ${join(runDir, "verdict.json")}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
