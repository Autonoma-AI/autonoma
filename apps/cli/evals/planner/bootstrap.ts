/**
 * Bootstrap a case's frozen artifacts by running the planner on the clean tree.
 *
 *   checkout(sha) -> copy to sandbox -> apply strip.patch (clean) -> seed project
 *   context -> run the planner steps in order (skipping test generation) -> copy the
 *   produced artifacts into cases/<repo>/artifacts/
 *
 *   pnpm --filter @autonoma-ai/planner eval:bootstrap -- --repo <name> \
 *        [--frontend <dir>] [--backends <a,b>] [--model <id>] [--timeout <min-per-step>]
 *
 * This is the one-time step that fills artifacts/ so the SDK eval (Layer 2) and the
 * per-step planner eval (Layer 1) have their frozen spec. Re-run to regenerate.
 */
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { ensureCachedCheckout } from "../framework/checkout";
import { contextPath, loadCoords } from "../framework/corpus";
import { copyTree, git } from "../framework/git";
import { artifactsDir, caseDir, runDir as runDirFor } from "../framework/paths";
import { runPlanner } from "../framework/run-planner-step";

const OUTPUT_SLUG = "eval";
const DEFAULT_TIMEOUT_MIN = 30;

/**
 * The planner steps to run, in order. Test generation is skipped; `recipeBuilder` is skipped too -
 * it no longer produces a frozen recipe (it hands off to the SDK-integration agent, which generates
 * `recipe.json` at eval time), so a case carries no frozen recipe to bootstrap.
 */
const BOOTSTRAP_STEPS = ["projectMapper", "pagesFinder", "kb", "entityAudit", "scenarioRecipe"];

/** Artifacts to promote into the case (file or dir); missing ones are warned, not fatal. */
const ARTIFACTS = ["project-map.json", "pages.json", "AUTONOMA.md", "skills", "entity-audit.md", "scenarios.md"];

interface Args {
    repo: string;
    frontend?: string;
    backends?: string[];
    model?: string;
    timeoutMin: number;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { repo: "", timeoutMin: DEFAULT_TIMEOUT_MIN };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === "--repo") a.repo = argv[++i] ?? "";
        else if (v === "--frontend") a.frontend = argv[++i];
        else if (v === "--backends")
            a.backends = (argv[++i] ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        else if (v === "--model") a.model = argv[++i];
        else if (v === "--timeout") a.timeoutMin = Number(argv[++i]);
    }
    if (!a.repo) throw new Error("--repo <name> is required");
    return a;
}

function log(msg: string): void {
    process.stdout.write(`\n=== ${msg} ===\n`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const coords = loadCoords(args.repo);

    const ctxPath = contextPath(args.repo);
    if (!existsSync(ctxPath)) {
        throw new Error(`Case "${args.repo}" is missing context.json (required to run the planner) at ${ctxPath}.`);
    }
    const apiToken = process.env.AUTONOMA_API_TOKEN?.trim();
    if (apiToken == null || apiToken === "") {
        throw new Error("AUTONOMA_API_TOKEN is required (the planner runs its models through the managed proxy).");
    }

    const cacheDir = await ensureCachedCheckout(coords);

    const stamp = String(Date.now());
    const runDir = runDirFor(args.repo, `bootstrap-${stamp}`);
    mkdirSync(runDir, { recursive: true });
    const sandbox = join(runDir, "sandbox");

    log("copy checkout -> sandbox, apply strip.patch (clean)");
    await copyTree(cacheDir, sandbox);
    await git(sandbox, ["apply", "--whitespace=nowarn", join(caseDir(args.repo), "strip.patch")]);

    const home = join(runDir, "home");
    const outputDir = join(home, ".autonoma", OUTPUT_SLUG);
    mkdirSync(outputDir, { recursive: true });
    await copyFile(ctxPath, join(outputDir, ".project-context.json"));

    const timeoutMs = args.timeoutMin > 0 ? args.timeoutMin * 60_000 : 0;
    const results: { step: string; ok: boolean }[] = [];
    for (const step of BOOTSTRAP_STEPS) {
        log(`planner step: ${step}`);
        const run = await runPlanner({
            step,
            label: step,
            frontend: args.frontend,
            backends: args.backends,
            projectRoot: sandbox,
            home,
            slug: OUTPUT_SLUG,
            apiToken,
            apiUrl: process.env.AUTONOMA_API_URL,
            model: args.model,
            runDir,
            timeoutMs,
        });
        const ok = run.exitCode === 0 && !run.timedOut;
        results.push({ step, ok });
        if (!ok)
            console.error(
                `[bootstrap] step "${step}" exited ${run.exitCode ?? "?"} (timedOut=${run.timedOut}); see ${run.logPath}`,
            );
    }

    log("promote produced artifacts -> cases/<repo>/artifacts/");
    const dest = artifactsDir(args.repo);
    mkdirSync(dest, { recursive: true });
    const promoted: string[] = [];
    const missing: string[] = [];
    for (const name of ARTIFACTS) {
        const src = join(outputDir, name);
        if (!existsSync(src)) {
            missing.push(name);
            continue;
        }
        await cp(src, join(dest, name), { recursive: true });
        promoted.push(name);
    }

    log("bootstrap summary");
    process.stdout.write(`steps: ${results.map((r) => `${r.step}${r.ok ? "" : "(FAILED)"}`).join(", ")}\n`);
    process.stdout.write(`promoted: ${promoted.join(", ") || "(none)"}\n`);
    if (missing.length > 0) process.stdout.write(`missing (not produced): ${missing.join(", ")}\n`);
    process.stdout.write(`\nartifacts dir: ${dest}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
