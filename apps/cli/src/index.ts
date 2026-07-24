// MUST be first: guards the Node version before ink/react (below) load.
import "./core/ensure-node";

// Before react/ink load: without this the published CLI runs React's
// development build - slower renders and far heavier memory retention.
process.env.NODE_ENV ??= "production";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadRecipeFromDisk } from "./agents/04-recipe-builder/phases/submit";
import { runSdkCommand } from "./agents/04-recipe-builder/sdk-command";
import { loadConfig } from "./config";
import type { AgentResult } from "./core/agent";
import { track, trackError, flushAnalytics } from "./core/analytics";
import { BOLD, DIM, PRIMARY, RESET } from "./core/colors";
import { type ProjectContext, loadContext } from "./core/context";
import { formatException, describeKnownError, supportReference, isUserCancellation } from "./core/errors";
import { installInterruptHandler, installTerminationDiagnostics, restoreTerminal } from "./core/interrupt";
import { DEFAULT_MODEL } from "./core/model";
import { ensureOutputDir } from "./core/output";
import { teardownUi } from "./core/ui-lifecycle";
import { readEnv } from "./env";
import * as p from "./ui/prompts";

// tsup emits source maps; ask Node to apply them so any stack that does reach
// our own code points at src/* instead of the bundled dist/index.js.
process.setSourceMapsEnabled(true);
import { loadGitInfo, readGitInfo, saveGitInfo } from "./core/git";
import { notify } from "./core/notify";
import {
    applySelection,
    defaultBackendsFor,
    formatBackendScope,
    formatFrontendScope,
    loadProjectMap,
    type ProjectMap,
    pickDefaultSelection,
    renderProjectMap,
    resolveSelection,
    saveProjectMap,
    type ScopeSelection,
} from "./core/project-map";
import {
    initialState,
    loadState,
    markStep,
    nextPendingStep,
    saveState,
    STEP_ORDER,
    type StepName,
    type PipelineState,
} from "./core/state";
import { uploadArtifacts } from "./core/upload";
import { CLI_VERSION } from "./core/version";
import { STEP_INTROS, STEP_SUMMARIES } from "./ui/steps";
import { getActiveStore, type RunStore } from "./ui/store";

const PAGES_FILE = "pages.json";

async function savePages(
    outputDir: string,
    pages: Map<string, { route: string; path: string; description: string }>,
): Promise<void> {
    const obj = Object.fromEntries(pages);
    await writeFile(join(outputDir, PAGES_FILE), JSON.stringify(obj, null, 2), "utf-8");
}

async function loadPages(
    outputDir: string,
): Promise<Map<string, { route: string; path: string; description: string }>> {
    try {
        const raw = await readFile(join(outputDir, PAGES_FILE), "utf-8");
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj));
    } catch {
        return new Map();
    }
}

function parseArgs(argv: string[]) {
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                args[key] = next;
                i++;
            } else {
                args[key] = true;
            }
        }
    }
    return args;
}

// Pull a flag's value only when it was given as `--key value` (a string), not
// as a bare boolean flag or absent. Keeps callers from having to narrow the
// `string | boolean | undefined` index type by hand.
function strArg(args: Record<string, string | boolean>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

const STEP_LABELS: Record<StepName, string> = {
    projectMapper: "Map your project structure",
    pagesFinder: "Find your pages",
    kb: "Build a knowledge base",
    entityAudit: "Map your data models",
    scenarioRecipe: "Design test scenarios",
    recipeBuilder: "Set up test data",
    testGenerator: "Generate the tests",
};

function isStepName(value: string): value is StepName {
    return value in STEP_LABELS;
}

// Step summaries and intros live in ui/steps.ts so the dashboard's help modal
// shares the exact copy the prompts use.

/**
 * Turn the mapper's candidate map into a single testable surface. Precedence:
 * (1) an explicit selection supplied by the caller (flags / harness) always wins;
 * (2) interactively, ask via a radio (frontend) + checkbox (backends) picker;
 * (3) non-interactively with no explicit choice, only proceed if unambiguous
 *     (exactly one frontend), otherwise return undefined so the caller pauses.
 */
async function resolveScopeSelection(
    map: ProjectMap,
    config: ReturnType<typeof loadConfig>,
    nonInteractive?: boolean,
): Promise<ScopeSelection | undefined> {
    if (config.frontend != null) {
        // Resolve tolerantly first: a fullstack app's own backend may be named at the
        // app root or a nested api dir depending on the run, so match the requested
        // path against what this map actually produced before defaulting the backends.
        const requestedFrontend = resolveSelection(map, { frontend: config.frontend, backends: [] }).frontend;
        // An explicit --backends is validated loudly by applySelection; a defaulted set
        // comes from the LLM's dependsOn, so drop entries that map to no real backend
        // instead of letting them reach applySelection and hard-fail the whole run.
        const backends = config.backends ?? defaultBackendsFor(map, requestedFrontend);
        return resolveSelection(map, { frontend: config.frontend, backends });
    }

    if (!nonInteractive) return promptScopeSelection(map);

    return pickDefaultSelection(map);
}

/**
 * Interactive radio (frontend) + checkbox (backends, pre-checked to the
 * frontend's dependencies). Esc on the backends question goes BACK to the
 * frontend pick; the flow can only move forward or back, never abort the run.
 */
async function promptScopeSelection(map: ProjectMap): Promise<ScopeSelection> {
    while (true) {
        const frontend = await p.select({
            message: "Which frontend do you want to plan tests for?",
            detail: "One frontend per run - the whole test suite is planned against it.",
            options: map.frontends.map((f) => ({ value: f.path, label: `${f.path}  [${f.framework}]`, hint: f.why })),
        });
        if (p.isCancel(frontend)) continue;

        if (map.backends.length === 0) return { frontend, backends: [] };

        // Resolve dependsOn through the same tolerant matcher the non-interactive path uses, so a
        // dependency named by its data-layer schema path still pre-checks its owning backend option
        // (whose value is the backend's own path) instead of silently going un-checked.
        const needed = defaultBackendsFor(map, frontend);
        const backends = await p.multiselect({
            message: "Which backends does this frontend talk to?",
            detail:
                "Pick EVERY backend and data layer it depends on - you can select several. " +
                "The ones the mapper detected are pre-checked.",
            options: map.backends.map((b) => ({ value: b.path, label: `${b.path}  [${b.framework}]`, hint: b.why })),
            initialValues: needed,
            required: false,
            cancelable: true,
        });
        if (p.isCancel(backends)) continue; // esc: back to the frontend pick

        return { frontend, backends };
    }
}

async function runStep(
    step: StepName,
    outputDir: string,
    state: PipelineState,
    config: ReturnType<typeof loadConfig>,
    projectContext?: ProjectContext,
    nonInteractive?: boolean,
    retryGuidance?: string,
): Promise<PipelineState> {
    const label = STEP_LABELS[step];
    p.note(STEP_INTROS[step], `Step: ${label}`);

    const stepStartedAt = Date.now();
    track("cli_step_started", { step });

    state = await markStep(outputDir, state, step, "running");
    getActiveStore()?.startStep(step);

    if (step !== "pagesFinder" && projectContext && !projectContext.pages) {
        const pages = await loadPages(outputDir);
        if (pages.size > 0) {
            projectContext = { ...projectContext, pages: [...pages.values()] };
        }
    }
    // Page count sizes the page-scaled ETA budgets (kb, test generation).
    const knownPages = projectContext?.pages?.length ?? 0;
    if (knownPages > 0) getActiveStore()?.setSizes({ pages: knownPages });

    // Size signals for the analytics event - the measured-duration data shows
    // repo size dominates step time, so future ETA heuristics need these.
    let stepMetrics: Record<string, number> = {};

    try {
        let result: AgentResult | undefined;

        switch (step) {
            case "projectMapper": {
                const { runProjectMapper } = await import("./agents/00-project-mapper/index");
                const map = await runProjectMapper({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    nonInteractive,
                });
                if (map == null) {
                    result = { success: false, artifacts: [], summary: "Project mapper did not produce a map." };
                    break;
                }
                if (map.frontends.length === 0) {
                    result = {
                        success: false,
                        artifacts: [],
                        summary: "Project mapper found no frontend to test. Point --project at a codebase with a UI.",
                    };
                    break;
                }

                // The mapper only DISCOVERS candidates. Narrow to the one frontend we test
                // (radio) plus the backends it needs (checkbox). When non-interactive and
                // ambiguous, persist the candidates and pause so the caller (Claude / CI)
                // can resume with --frontend/--backends.
                const selection = await resolveScopeSelection(map, config, nonInteractive);
                if (selection == null) {
                    await saveProjectMap(outputDir, map);
                    p.note(renderProjectMap(map), "Project map - candidates (pick one frontend + its backends)");
                    result = {
                        success: false,
                        paused: true,
                        artifacts: [],
                        summary:
                            `Found ${map.frontends.length} candidate frontends. Choose one and its backends, then ` +
                            "resume with --frontend <path> --backends <path,path>.",
                    };
                    break;
                }

                const scoped = applySelection(map, selection);
                stepMetrics = {
                    frontend_count: map.frontends.length,
                    backend_count: map.backends.length,
                    ignored_count: map.ignore.length,
                };
                await saveProjectMap(outputDir, scoped);
                p.note(renderProjectMap(scoped), "Project map");
                break;
            }
            case "pagesFinder": {
                const { runPageFinder } = await import("./agents/00-pages-finder/index");
                const projectMap = await loadProjectMap(outputDir);
                const pages = await runPageFinder({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    nonInteractive,
                    extraMessage: projectMap != null ? formatFrontendScope(projectMap) : undefined,
                });
                await savePages(outputDir, pages);
                stepMetrics = { page_count: pages.size };
                if (pages.size > 0) getActiveStore()?.setSizes({ pages: pages.size });
                break;
            }
            case "kb": {
                const { runKBGenerator } = await import("./agents/01-kb-generator/index");
                stepMetrics = { page_count: projectContext?.pages?.length ?? 0 };
                result = await runKBGenerator({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    projectContext,
                    nonInteractive,
                    retryGuidance,
                });
                break;
            }
            case "entityAudit": {
                const { runEntityAudit } = await import("./agents/02-entity-audit/index");
                const auditMap = await loadProjectMap(outputDir);
                result = await runEntityAudit({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    projectContext,
                    nonInteractive,
                    retryGuidance,
                    scopeHint: auditMap != null ? formatBackendScope(auditMap) : undefined,
                });
                break;
            }
            case "scenarioRecipe": {
                const { runScenarioRecipe } = await import("./agents/03-scenario-recipe/index");
                const recipeMap = await loadProjectMap(outputDir);
                result = await runScenarioRecipe({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    config,
                    projectContext,
                    nonInteractive,
                    retryGuidance,
                    scopeHint: recipeMap != null ? formatBackendScope(recipeMap) : undefined,
                });
                break;
            }
            case "recipeBuilder": {
                const { runRecipeBuilder } = await import("./agents/04-recipe-builder/index");
                const { parsePermissionMode } = await import("./agents/04-recipe-builder/launcher");
                result = await runRecipeBuilder({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    config,
                    projectContext,
                    nonInteractive,
                    retryGuidance,
                    agent: config.agent,
                    permissionMode: parsePermissionMode(config.permissionMode),
                });
                break;
            }
            case "testGenerator": {
                const { runTestGenerator } = await import("./agents/05-test-generator/index");
                const pages = await loadPages(outputDir);
                stepMetrics = { page_count: pages.size };
                result = await runTestGenerator({
                    projectRoot: config.projectRoot,
                    outputDir,
                    modelId: config.modelId,
                    config,
                    projectContext,
                    nonInteractive,
                    pages,
                    retryGuidance,
                });
                break;
            }
        }

        if (result && !result.success) {
            if (result.paused) {
                state = await markStep(outputDir, state, step, "paused");
                p.log.info(`Paused: ${label} - ${result.summary}`);
            } else {
                state = await markStep(outputDir, state, step, "failed");
                p.log.error(`Failed: ${label} - ${result.summary}`);
                trackError(new Error(result.summary), { step, source: "step_result" });
            }
        } else {
            state = await markStep(outputDir, state, step, "done");
            p.log.success(`Completed: ${label}`);
        }
    } catch (err) {
        // The user deliberately stopped (Ctrl+C / "cancel" at a prompt). That's not
        // a failure: let the run-level handler save progress and exit quietly, and
        // don't report it to error tracking, where it would look like a bug.
        if (isUserCancellation(err)) throw err;
        state = await markStep(outputDir, state, step, "failed");
        const known = describeKnownError(err);
        if (known) {
            // A recognized, actionable failure - the raw stack is library-internal
            // noise here, so we show the fix instead.
            p.log.error(`Failed: ${label} - ${known.title}`);
            p.log.info(known.hint);
        } else {
            const message = err instanceof Error ? err.message : String(err);
            p.log.error(`Failed: ${label} - ${message}`);
            // Full stack so users can copy-paste it when reporting the issue.
            console.error(`\x1b[2m${formatException(err)}\x1b[0m`);
            // One short line that maps this failure to its analytics event(s).
            console.error(`\x1b[2m${supportReference({ step })}\x1b[0m`);
            p.log.info("If you report this, please include the error output above.");
        }
        trackError(err, { step, source: "step_exception" });
    }

    getActiveStore()?.endStep(step, state.steps[step]);

    if (step === "entityAudit") {
        const { parseEntityNames } = await import("./core/parse-entity-audit");
        stepMetrics = { ...stepMetrics, entity_count: (await parseEntityNames(outputDir)).length };
    }
    if (step === "testGenerator") {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(join(outputDir, "qa-tests"), { recursive: true }).catch(() => []);
        stepMetrics = {
            ...stepMetrics,
            test_count: entries.map((e) => String(e)).filter((e) => e.endsWith(".md")).length,
        };
    }

    track("cli_step_completed", {
        step,
        status: state.steps[step],
        duration_ms: Date.now() - stepStartedAt,
        ...stepMetrics,
    });

    return state;
}

type FailureAction = { kind: "retry"; guidance?: string } | { kind: "exit" };

async function promptStepFailure(label: string): Promise<FailureAction> {
    notify("Autonoma", `${label} failed - action needed`);

    while (true) {
        const action = await p.select({
            message: `${label} failed. What would you like to do?`,
            options: [
                { value: "retry", label: "Retry this step", hint: "Run it again from the top" },
                {
                    value: "guidance",
                    label: "Retry with guidance",
                    hint: "Tell the agent what went wrong or what to focus on",
                },
                { value: "exit", label: "Stop here (progress saved)", hint: "Resume later with --resume" },
            ],
        });

        if (p.isCancel(action) || action === "exit") return { kind: "exit" };
        if (action === "retry") return { kind: "retry" };

        const guidance = await p.text({
            message: "What should the agent do differently?",
            placeholder: "e.g. the part that failed, or what to focus on",
            cancelable: true,
        });
        if (p.isCancel(guidance)) continue; // esc: back to the retry choices

        const trimmed = guidance.trim();
        return { kind: "retry", guidance: trimmed || undefined };
    }
}

// A failed step should never hard-stop an interactive run - the user gets to
// retry (optionally steering the agent) until it passes or they bail out.
async function runStepWithRecovery(
    step: StepName,
    outputDir: string,
    state: PipelineState,
    config: ReturnType<typeof loadConfig>,
    projectContext?: ProjectContext,
    nonInteractive?: boolean,
): Promise<PipelineState> {
    let guidance: string | undefined;

    while (true) {
        state = await runStep(step, outputDir, state, config, projectContext, nonInteractive, guidance);

        if (state.steps[step] !== "failed" || nonInteractive) return state;

        const action = await promptStepFailure(STEP_LABELS[step]);
        if (action.kind === "exit") return state;

        guidance = action.guidance;
        track("cli_step_retried", { step, with_guidance: guidance != null });
    }
}

async function showStatus(outputDir: string) {
    const state = await loadState(outputDir);
    console.log("\nPipeline Status:");
    for (const [step, status] of Object.entries(state.steps)) {
        const icon =
            status === "done"
                ? "+"
                : status === "running"
                  ? "~"
                  : status === "paused"
                    ? "‖"
                    : status === "failed"
                      ? "x"
                      : " ";
        const label = isStepName(step) ? STEP_LABELS[step] : step;
        console.log(`  [${icon}] ${label}: ${status}`);
    }
}

interface MountedDashboard {
    store: RunStore;
    unmount: () => void;
}

/**
 * Mount the Ink dashboard - interactive TTY only. Mounted before the setup
 * questions so every prompt (resume, project context, scope selection, step
 * failure) renders as the docked ACTION REQUIRED panel; there is no separate
 * terminal-mode prompt path anymore.
 */
async function mountDashboard(outputDir: string, projectSlug: string): Promise<MountedDashboard | undefined> {
    const isTTY = !!process.stdout.isTTY && !!process.stdin.isTTY;
    if (!isTTY) return undefined;

    const { mountUi } = await import("./ui/mount");
    return mountUi({
        outputDir,
        meta: { title: "Generating your test suite", project: projectSlug, version: CLI_VERSION },
    });
}

/**
 * Reflect an existing run's settled steps in the dashboard (resume). A stale
 * "running" from an interrupted session is skipped - that step will re-run,
 * and seeding it would show a spinner nothing is driving.
 */
function seedDashboard(ui: MountedDashboard | undefined, state: PipelineState): void {
    if (ui == null) return;
    for (const [step, status] of Object.entries(state.steps)) {
        if (isStepName(step) && (status === "done" || status === "failed" || status === "paused")) {
            ui.store.endStep(step, status);
        }
    }
}

const BANNER = `
${PRIMARY}${BOLD} █████╗ ██╗   ██╗████████╗ ██████╗ ███╗   ██╗ ██████╗ ███╗   ███╗ █████╗
██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗████╗  ██║██╔═══██╗████╗ ████║██╔══██╗
███████║██║   ██║   ██║   ██║   ██║██╔██╗ ██║██║   ██║██╔████╔██║███████║
██╔══██║██║   ██║   ██║   ██║   ██║██║╚██╗██║██║   ██║██║╚██╔╝██║██╔══██║
██║  ██║╚██████╔╝   ██║   ╚██████╔╝██║ ╚████║╚██████╔╝██║ ╚═╝ ██║██║  ██║
╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝
${RESET}
${DIM}  E2E Test Planner - Generate exhaustive test suites from your codebase${RESET}
`;

/**
 * Make sure the CLI is authenticated before doing anything else. The planner
 * runs on managed Autonoma credits via the Autonoma API token (AUTONOMA_API_TOKEN),
 * which the web app injects when it launches the CLI. There's no LLM key to
 * paste anymore - if the token is missing we error with instructions rather than
 * prompting. Returns false when unauthenticated.
 */
function ensureAutonomaAuth(): boolean {
    if (readEnv().AUTONOMA_API_TOKEN?.trim()) return true;

    p.log.error(
        "Not authenticated. Launch the planner from the Autonoma app, or set AUTONOMA_API_TOKEN (create a key at https://autonoma.app/settings/api-keys).",
    );
    return false;
}

async function main() {
    // Before anything else, arm diagnostics so a SIGTERM/SIGHUP or a swallowed async
    // error leaves a greppable breadcrumb instead of the run just vanishing.
    installTerminationDiagnostics();

    const args = parseArgs(process.argv.slice(2));
    const command = process.argv[2];

    if (command === "status") {
        const config = loadConfig({
            project: strArg(args, "project"),
            slug: strArg(args, "slug"),
        });
        if (!args.project) {
            console.log(`No --project flag passed; using current working directory: ${config.projectRoot}`);
        }
        const outputDir = await ensureOutputDir(config.projectSlug);
        await showStatus(outputDir);
        return;
    }

    if (command === "upload") {
        const config = loadConfig({
            project: strArg(args, "project"),
            slug: strArg(args, "slug"),
        });
        const outputDir = await ensureOutputDir(config.projectSlug);
        // Re-upload everything already generated in `~/.autonoma/<app>/`: the recipe
        // first (so scenarios exist before tests reference them), then the artifacts
        // (tests/kb/scenarios), which also marks the setup completed. Both endpoints
        // are idempotent, so this is safe to run repeatedly to recover a failed run.
        const recipeUploaded = await uploadRecipeFromDisk(outputDir, {
            apiUrl: config.autonomaApiUrl,
            apiToken: config.autonomaApiToken,
            generationId: config.autonomaGenerationId,
        });
        await uploadArtifacts(config, outputDir);
        await flushAnalytics();
        process.exit(recipeUploaded ? 0 : 1);
    }

    // `sdk <discover|up|down>` is the interactive agent's endpoint tool, not a
    // developer-facing command: it's non-interactive, prints JSON, and its exit code
    // signals HTTP success. It shells out from inside the handoff session.
    if (command === "sdk") {
        const exitCode = await runSdkCommand(process.argv.slice(3), {
            env: process.env,
            stdout: (text) => process.stdout.write(text),
            stderr: (text) => process.stderr.write(text),
        });
        process.exit(exitCode);
    }

    if (command === "help" || args.help) {
        console.log("Usage:");
        console.log(
            "  test-planner [run] [--project <path>] [--frontend <path>] [--backends <path,path>] [--model <id>] [--step <name>] [--resume] [--non-interactive] [--agent <claude|codex>] [--permission-mode <default|acceptEdits|bypassPermissions>]",
        );
        console.log("  test-planner status [--project <path>]");
        console.log("  test-planner upload [--project <path>]   # re-upload already-generated recipe + artifacts");
        console.log("");
        console.log("`run` is the default command; it may be omitted.");
        return;
    }

    console.log(BANNER);
    p.intro("Let's generate your test suite");

    // ESC no longer exits; Ctrl+C twice (within 3s) does, with a resume hint.
    const resumeCommand = `autonoma-planner --resume` + (args.project ? ` --project ${args.project}` : "");
    let mountedUi: MountedDashboard | undefined;
    installInterruptHandler({
        // exitCode defaults to 0 for a user-initiated Ctrl+C (progress saved, a clean stop);
        // an external SIGTERM/SIGHUP passes the conventional 143/129 so the flushed exit still
        // carries the signal code a reaper/CI reads, not a 0 that looks like normal completion.
        onExit: (exitCode = 0) => {
            track("cli_run_exited");
            mountedUi?.unmount();
            mountedUi = undefined;
            restoreTerminal();
            console.log("");
            p.log.warn(`Your progress is saved. To resume, run:\n  ${resumeCommand}`);
            void flushAnalytics().finally(() => process.exit(exitCode));
        },
    });

    const backendsArg = strArg(args, "backends");
    const config = loadConfig({
        project: strArg(args, "project"),
        model: strArg(args, "model"),
        slug: strArg(args, "slug"),
        frontend: strArg(args, "frontend"),
        backends:
            backendsArg != null
                ? backendsArg
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0)
                : undefined,
        agent: strArg(args, "agent"),
        permissionMode: strArg(args, "permission-mode"),
    });

    if (!ensureAutonomaAuth()) {
        return;
    }

    const nonInteractive = !!args["non-interactive"];

    const modelName = config.modelId ?? readEnv().OPENROUTER_MODEL ?? DEFAULT_MODEL;

    if (!args.project) {
        p.log.info(`No --project flag passed; using current working directory.`);
    }
    p.log.info(`Project: ${config.projectRoot}`);

    track("cli_run_started", { model: modelName, non_interactive: nonInteractive });

    const outputDir = await ensureOutputDir(config.projectSlug);
    let state = await loadState(outputDir);

    // Record the commit the analysis is based on, once, on the first run - so a
    // --resume keeps the original commit and the upload can report it to Autonoma.
    if ((await loadGitInfo(outputDir)) == null) {
        const gitInfo = await readGitInfo(config.projectRoot);
        if (gitInfo != null) {
            await saveGitInfo(outputDir, gitInfo);
            p.log.info(`Git commit: ${gitInfo.sha.slice(0, 8)}${gitInfo.dirty ? " (working tree dirty)" : ""}`);
        }
    }

    // Mount the dashboard BEFORE the setup questions: every prompt from here
    // on renders as the docked ACTION REQUIRED panel inside the TUI.
    if (!nonInteractive) mountedUi = await mountDashboard(outputDir, config.projectSlug);

    let isResuming = !!(args.resume || args.step);
    let projectContext: ProjectContext | undefined;

    const hasProgress = Object.values(state.steps).some((s) => s === "done" || s === "running");

    // A fresh, interactive run opens with a welcome. Skipped when resuming, on a
    // targeted --step, or when a prior run left progress (nothing new to greet).
    if (!nonInteractive && !isResuming && !hasProgress) {
        await p.welcome({
            title: "Let's build your test suite.",
            lines: [
                "Autonoma analyzes your codebase - its pages, data models, and user flows - and " +
                    "generates a full suite of end-to-end test cases that cover them, so you get real " +
                    "test coverage without writing a single test yourself.",
                "It takes a little while, and the whole run happens right here so you can watch it work.",
                "This analysis is free for new accounts.",
            ],
            cta: "Press enter to begin",
        });
    }

    if (!isResuming && !nonInteractive && hasProgress) {
        const completedSteps = Object.entries(state.steps)
            .filter(([, s]) => s === "done")
            .map(([name]) => (isStepName(name) ? STEP_LABELS[name] : name))
            .join(", ");

        const resume = await p.confirm({
            message: `Found a previous run${completedSteps ? ` (completed: ${completedSteps})` : ""}. Resume from where you left off?`,
        });

        if (p.isCancel(resume)) {
            mountedUi?.unmount();
            mountedUi = undefined;
            p.log.warn("Cancelled.");
            return;
        }

        if (resume) {
            isResuming = true;
        } else {
            // Starting over: drop the old run's step marks, or the fresh run
            // inherits stale "done" states the moment it saves progress.
            state = initialState();
            await saveState(outputDir, state);
        }
    }

    if (isResuming) seedDashboard(mountedUi, state);

    // Project context is optional: the agents discover the codebase themselves.
    // A .project-context.json (from an older run, or hand-written to steer the
    // agents) is still honored when present.
    const saved = await loadContext(outputDir);
    if (saved) {
        projectContext = saved;
        p.log.info(`Loaded project context from previous run`);
    }

    p.note(
        `${outputDir}\n\n` +
            `All generated files (knowledge base, scenarios, recipe, tests) live here.\n` +
            `It's a hidden folder in your home directory - in Finder/Explorer use "Go to folder"\n` +
            `or reveal hidden files (macOS: Cmd+Shift+. ) to see it.`,
        "Output folder",
    );

    const stepArg = strArg(args, "step");
    const targetStep: StepName | undefined = stepArg != null && isStepName(stepArg) ? stepArg : undefined;
    if (stepArg != null && targetStep == null) {
        mountedUi?.unmount();
        mountedUi = undefined;
        p.log.error(`Unknown --step "${stepArg}". Valid steps: ${Object.keys(STEP_LABELS).join(", ")}`);
        return;
    }

    if (targetStep) {
        if (targetStep === "testGenerator" && state.steps.scenarioRecipe !== "done") {
            mountedUi?.unmount();
            mountedUi = undefined;
            p.log.error("Cannot run test generation yet - the scenario recipe step must complete first.");
            return;
        }
        state = await runStepWithRecovery(targetStep, outputDir, state, config, projectContext, nonInteractive);
        mountedUi?.unmount();
        mountedUi = undefined;
        if (state.steps[targetStep] === "failed") {
            const retryCommand =
                `autonoma-planner --step ${targetStep}` + (args.project ? ` --project ${args.project}` : "");
            p.log.warn(`Your progress is saved. To retry this step, run:\n  ${retryCommand}`);
            process.exitCode = 1;
        }
        p.outro("Done");
        return;
    }

    const startStep = isResuming ? nextPendingStep(state) : "projectMapper";
    if (!startStep) {
        mountedUi?.unmount();
        mountedUi = undefined;
        p.log.success("All steps complete.");
        return;
    }

    const steps = STEP_ORDER;
    const startIdx = steps.indexOf(startStep);

    // Up-front overview so it's clear what each step does before any of them run.
    p.note(steps.map((s, idx) => `${idx + 1}. ${STEP_LABELS[s]} - ${STEP_SUMMARIES[s]}`).join("\n"), "Here's the plan");

    try {
        for (let i = startIdx; i < steps.length; i++) {
            const step = steps[i]!;
            state = await runStepWithRecovery(step, outputDir, state, config, projectContext, nonInteractive);

            if (state.steps[step] === "paused") {
                break;
            }

            // Only reached when the user chose to stop after a failure, or in
            // non-interactive mode where there's nobody to ask.
            if (state.steps[step] === "failed") {
                p.log.error("Pipeline stopped due to failure.");
                p.log.warn(`Your progress is saved. To retry this step, run:\n  ${resumeCommand}`);
                process.exitCode = 1;
                break;
            }
        }
    } catch (err) {
        mountedUi?.unmount();
        mountedUi = undefined;
        if (isUserCancellation(err)) {
            p.log.warn("Your progress is saved. Run again with --resume to continue from where you left off.");
            return;
        }
        throw err;
    }

    const stepsDone = Object.values(state.steps).filter((s) => s === "done").length;
    track("cli_run_completed", { steps_done: stepsDone });

    // Only upload once the whole pipeline finished - a paused/failed run has
    // incomplete artifacts and would publish a half-built test suite.
    const allStepsDone = Object.values(state.steps).every((s) => s === "done");
    if (allStepsDone) {
        try {
            await uploadArtifacts(config, outputDir);
            track("cli_artifacts_uploaded");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            p.log.error(`Failed to upload artifacts: ${message}`);
            console.error(`\x1b[2m${formatException(err)}\x1b[0m`);
            console.error(`\x1b[2m${supportReference({ phase: "artifact_upload" })}\x1b[0m`);
            p.log.info(`Your artifacts are saved in ${outputDir}. Re-run the CLI to retry the upload.`);
            track("cli_artifacts_upload_failed", { message });
            trackError(err, { source: "artifact_upload" });
        }
    }

    const anyFailed = Object.values(state.steps).some((s) => s === "failed");
    getActiveStore()?.finish({ kind: allStepsDone ? "complete" : anyFailed ? "failed" : "paused" });
    mountedUi?.unmount();
    mountedUi = undefined;

    // The dashboard frame is cleared on unmount; leave a durable plain-text
    // summary and the next step in the scrollback instead.
    if (allStepsDone) {
        p.log.success("Your test suite is ready.");
        p.log.info(`Artifacts: ${outputDir}`);
        p.log.info("Next: connect a preview environment and run it -> https://autonoma.app");
    }
    p.outro("Done");
}

main()
    .then(() => flushAnalytics())
    .catch(async (err) => {
        // The dashboard may still be up; kill it first so the console is real
        // again - otherwise the error prints into the dead frame's captured
        // log and the user sees nothing.
        teardownUi();
        // A cancellation that bubbled all the way up - exit quietly without a stack
        // or an error-tracking event; the user chose to stop.
        if (isUserCancellation(err)) {
            await flushAnalytics();
            process.exit(0);
        }
        const known = describeKnownError(err);
        if (known) {
            console.error(`\x1b[31m${known.title}\x1b[0m`);
            console.error(known.hint);
        } else {
            console.error(err);
            console.error(`\x1b[2m${supportReference()}\x1b[0m`);
        }
        trackError(err, { source: "uncaught" }, false);
        await flushAnalytics();
        process.exit(1);
    });
