import { existsSync } from "node:fs";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type LanguageModel, tool } from "ai";
import { glob } from "glob";
import { z } from "zod";
import type { AppConfig } from "../../config";
import { type AgentResult, formatRetryGuidance, runAgent } from "../../core/agent";
import { track } from "../../core/analytics";
import { describeConcurrency, generationConcurrency } from "../../core/concurrency";
import { debugLog } from "../../core/debug";
import { createStepLogger } from "../../core/display";
import { formatException } from "../../core/errors";
import { loadGitignorePatterns } from "../../core/gitignore";
import { captureLog } from "../../core/logs";
import { resolveModel } from "../../core/model";
import { runPool } from "../../core/pool";
import { activeAgentNow } from "../../core/progress";
import { INVALID_DIR, isTestFile, TEST_FILE_GLOB, TESTS_DIR } from "../../core/test-files";
import { buildBashTool, buildGlobTool, buildGrepTool, buildListDirectoryTool, buildReadFileTool } from "../../tools";
import { getActiveStore } from "../../ui/store";
import type { RunPlan } from "../../ui/types";
import { type DiscoveredFeature, loadFeatures, runFeatureDiscovery } from "../00b-feature-discovery/index";
import { loadFlows } from "../01-kb-generator";
import { buildRunPlan, flowForRoute, planBudget, planFlowIds, targetTestCount } from "./budget";
import {
    ALL_NODES,
    CoverageState,
    type FeatureNode,
    JOURNEY_STATE_FILE,
    loadBfsState,
    type WorkerScope,
} from "./graph";
import { pageRootOf, partitionByPage } from "./partition";
import { SYSTEM_PROMPT } from "./prompt";
import { loadRecipeContext } from "./recipe-context";
import { renderRedTeamBrief } from "./red-team";
import { restoreDeletedTest } from "./restore-deleted-test";
import { runConsolidatedReview, type TestReviewFeedback } from "./review";
import { ReviewPipeline } from "./review-pipeline";
import { buildProposeTestsTool, TestRegistry } from "./test-registry";
import {
    buildCreateFolderTool,
    buildGetProgressTool,
    buildNextNodeTool,
    buildSpawnResearcherTool,
    buildWriteTestTool,
} from "./tools";
import { validateTestContent } from "./validation";
import { generateIndex } from "./write-index";

const MAX_CONCURRENCY = 8;

/**
 * Node id for the "/" route, which produces no path segments to slug. A literal
 * "/home" route would slug to the same thing; enqueue dedupes, so the collision
 * costs one of the two rather than corrupting the graph.
 */
const ROOT_PAGE_ID = "home";

/** Review → fix passes over the whole suite, when there is budget for them. */
const MAX_REVIEW_CYCLES = 4;

/**
 * Wall clock for the entire review → fix phase, checked between batches as well
 * as between cycles. Review quality is a nice-to-have on top of a generated
 * suite; an unbounded review is not - it has run for 5 and 14 hours on real
 * onboarding runs, and it fails open to "pass" anyway, so the tests it never got
 * to are no worse off than the ones it timed out on.
 */
const REVIEW_BUDGET_MS = 45 * 60 * 1000;

/**
 * Consecutive write_test validation rejections, with no test written in between,
 * that mean the loop will never converge. Validation happens before the tool
 * runs, so a rule the model cannot satisfy is retried until the step budget is
 * gone; this turns that into a fast, loud failure.
 */
const MAX_CONSECUTIVE_REJECTIONS = 25;
const REJECTION_MESSAGE_CHARS = 300;

/**
 * Steps one smoke-backfill agent gets to write a single test for a page that
 * generation left uncovered. Small on purpose: it has one node, one test, and no
 * queue to walk, so a large budget would only let it wander.
 */
const SMOKE_BACKFILL_STEPS = 25;

/**
 * The share of the remaining budget a review scan may spend, leaving the rest
 * to act on what it finds. A scan allowed the whole budget hands back findings
 * there is no time to fix - the full cost of reviewing for none of the benefit.
 */
const REVIEW_SCAN_SHARE = 0.6;

/**
 * The single node the journey pass explores, and the folder its tests land in.
 * The prompt has to name the id: this phase has no next_node tool, so an agent
 * not told the id invents one, and every write then relies on the unrecognized-id
 * fallback - which makes the correction event fire on healthy runs and stop
 * meaning anything.
 */
const JOURNEY_NODE_ID = "journeys";

/**
 * Sentinel a worker's tool loop returns once its slice is drained, so runAgent
 * treats the worker as done and does not "stopped without finishing" nudge it.
 * The value itself is discarded - the run's real result is rebuilt from the final
 * state after every worker and the smoke backfill have finished.
 */
const WORKER_SLICE_DRAINED: AgentResult = {
    success: true,
    artifacts: [],
    summary: "worker slice drained",
};

export interface TestGeneratorInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    /**
     * An already-built model, used in place of `modelId` for the whole step - the
     * BFS loop, researchers, journeys and the review/fix cycle all run on it. The
     * product never passes this; the model-comparison eval does, so it can drive
     * the step against a provider of its own (and meter it) without the CLI's
     * credit proxy in the way.
     */
    model?: LanguageModel;
    config?: AppConfig;
    nonInteractive?: boolean;
    pages: Map<string, { route: string; path: string; description: string }>;
    retryGuidance?: string;
}

interface PageEntry {
    route: string;
    path: string;
    description: string;
}

/**
 * Seed the graph from pages and features, before any model call. Exported so the
 * shape of the graph - which nodes exist, and which page each feature hangs off -
 * can be asserted without a provider.
 */
export async function preseedQueue(
    state: CoverageState,
    projectRoot: string,
    pages: Map<string, PageEntry>,
    features?: Map<string, DiscoveredFeature>,
): Promise<string> {
    let seeded = 0;

    // Feature discovery reports a feature's parent as `parentPagePath`, but what
    // it actually writes there is the page's ROUTE ("/", "/settings"). Indexing
    // only by source path meant no feature ever matched its page: every feature
    // node has been created with no parentId and no routePath, so a feature test
    // was written without knowing which route it lives on. Both keys are indexed,
    // since the field name says path and the data says route.
    const pageIdByKey = new Map<string, string>();

    for (const [absolutePath, page] of pages) {
        const routeSegments = page.route
            .split("/")
            .filter(Boolean)
            .map((s) => s.replace(/[[\]$:]/g, "").replace(/\..*$/, "") || "param");

        // "/" has no segments. Skipping it dropped the app's main page from the
        // graph entirely - it got no tests of its own, and every feature hanging
        // off it was left parentless. On a dashboard-style product that is the
        // most important page there is.
        const id = routeSegments.length > 0 ? routeSegments.join("-") : ROOT_PAGE_ID;
        const name =
            routeSegments.length > 0
                ? routeSegments
                      .map((s) => s.replace(/-/g, " ").replace(/\bparam\b/, "[id]"))
                      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                      .join(" / ")
                : "Home";

        const relPath = absolutePath.startsWith(projectRoot)
            ? absolutePath.slice(projectRoot.length).replace(/^\//, "")
            : page.path;

        const routePath = page.route.startsWith("/") ? page.route : `/${page.route}`;
        pageIdByKey.set(absolutePath, id);
        pageIdByKey.set(page.path, id);
        pageIdByKey.set(routePath, id);

        const node: FeatureNode = {
            id,
            name,
            routePath,
            sourceFiles: [relPath],
            parentId: undefined,
            depth: 0,
            status: "queued",
            description: page.description,
        };
        if (state.enqueue(node)) seeded++;
    }

    if (features) {
        for (const [featureId, feature] of features) {
            const parentId = pageIdByKey.get(feature.parentPagePath) ?? undefined;
            const parentNode = parentId ? state.nodes.get(parentId) : undefined;

            const node: FeatureNode = {
                id: featureId,
                name: feature.name,
                routePath: parentNode?.routePath,
                sourceFiles: feature.sourceFiles,
                parentId,
                depth: 1,
                status: "queued",
                description: feature.description,
                interactiveElements: feature.interactiveElements,
            };
            if (state.enqueue(node)) seeded++;
        }
    }

    return seeded > 0
        ? `\nPre-seeded: ${seeded} nodes (pages + sub-features). Call next_node to start processing them one at a time.`
        : "";
}

/**
 * The opening prompt for one worker. It names the slice so the agent does not
 * read "process EVERY node" as a claim over the whole graph - next_node only ever
 * hands it its own, but an agent that believes it owns everything reports the run
 * as unfinished when its queue drains.
 */
function scopedPrompt(worker: WorkerScope, state: CoverageState): string {
    const page = state.nodes.get(worker.id);
    const label = page?.routePath ?? page?.name ?? worker.id;
    return `Generate E2E test cases for the "${label}" area of the product.

Other agents are covering the other areas at the same time, so next_node will only ever hand you
nodes belonging to this one. Process every node it gives you until it returns done, then call
finish. Do not try to reach nodes outside this area.

MANDATORY PROCESS:
1. Call next_node to get the first node
2. For EACH node returned by next_node:
   a. Read its source files and explore the surrounding codebase
   b. Catalog every interactive element
   c. Call propose_tests with what you plan to write, then write only the accepted ones
   d. Call next_node to get the next node
3. When next_node returns done, call finish`;
}

/**
 * Print the suite's reasoning as plain lines for headless / CI runs, where there
 * is no dashboard to show the "Test Plan" file. Same content the TUI renders:
 * the pitch, the budget split, and each flow's tier, argument, risk and entry.
 */
function printPlanReasoning(plan: RunPlan): void {
    console.log(`  Pitch: ${plan.pitch}`);
    console.log(
        `  Budget: ${plan.total} tests - ${plan.smokeFloor} smoke, then tier 1: ${plan.tierTotals[1]}, ` +
            `tier 2: ${plan.tierTotals[2]}, tier 3: ${plan.tierTotals[3]}`,
    );
    for (const flow of plan.flows) {
        const risk = flow.riskDrivers.length > 0 ? flow.riskDrivers.join(", ") : "none flagged";
        console.log(`  [T${flow.tier}] ${flow.feature} - ${flow.allowance} ${flow.allowance === 1 ? "test" : "tests"}`);
        console.log(`        why:   ${flow.tierReason}`);
        console.log(`        risk:  ${risk}`);
        console.log(`        entry: ${flow.entryPoints.join(", ")}`);
    }
}

export async function runTestGenerator(input: TestGeneratorInput): Promise<AgentResult> {
    const model = resolveModel(input);

    // Pages generated at once, each by its own agent. Resolved here rather than at
    // module load so an operator's --max-old-space-size is in effect before it is
    // read. Sized from the heap this process can actually use rather than a fixed
    // value, which is wrong in both directions: a fixed 4 throttled large machines
    // while still dying on the default heap ceiling, where runs at 56 and 113 pages
    // both ran out of memory with the same 4 workers.
    const generationLimit = generationConcurrency();

    const ignorePatterns = await loadGitignorePatterns(input.projectRoot);
    const existingState = await loadBfsState(input.outputDir);
    const state = existingState ?? new CoverageState();

    let result: AgentResult | undefined;

    // Finish is scoped to the calling worker, because parallel generation hands
    // each agent its own slice of the graph via next_node - so "am I done" is a
    // question about THIS worker's slice, not the whole run. Gating it on the
    // global queue (`stats.queued`) meant every worker but the last one to drain
    // was told "nodes still queued" (nodes that belong to OTHER workers) while its
    // own next_node returned done - a contradiction the model could not satisfy,
    // so it spun until the step cap. (The primary termination guarantee is the
    // drain stop in buildAgentConfig; this scoping removes the contradictory
    // signal so a worker that does call finish is answered correctly.) A
    // deliberately skipped node is a valid outcome - the smoke-floor backfill
    // below guarantees every page still gets a test - so there is no
    // minimum-tested gate; the guard only holds finish back while the worker still
    // has its own nodes to process or one still open.
    const buildFinishTool = (worker: WorkerScope) =>
        tool({
            description: "Call once next_node has returned done - every node in your area is tested or skipped.",
            inputSchema: z.object({
                summary: z.string().describe("Coverage summary"),
            }),
            execute: async (finishInput) => {
                if (!state.hasDrained(worker)) {
                    const mineRemaining = state.remainingFor(worker);
                    if (mineRemaining > 0) {
                        return {
                            error: `Cannot finish: ${mineRemaining} node${mineRemaining === 1 ? "" : "s"} still in your queue. Call next_node until it returns done.`,
                        };
                    }
                    return {
                        error: `Cannot finish: you are still exploring a node. Call next_node to close it out first.`,
                    };
                }

                const stats = state.summary();
                result = {
                    success: true,
                    artifacts: state.allTestPaths(),
                    summary: finishInput.summary,
                };

                return {
                    ...stats,
                    message: "Test generation complete.",
                };
            },
        });

    let kbContext = "";
    try {
        const autonomaMd = await readFile(join(input.outputDir, "AUTONOMA.md"), "utf-8");
        kbContext += `\n## Knowledge Base (AUTONOMA.md)\n\n${autonomaMd}\n`;
    } catch (err) {
        debugLog("AUTONOMA.md not readable; generating without KB context", { err });
    }

    // The recipe is the data contract; the scenario is its human-facing summary and
    // can disagree with it. Prefer the recipe, and fall back to the scenario only
    // when there is no recipe to read (the pipeline can reach test generation before
    // the SDK step has produced one).
    const recipeContext = await loadRecipeContext(input.outputDir);
    if (recipeContext !== "") {
        kbContext += recipeContext;
    } else {
        try {
            const scenariosMd = await readFile(join(input.outputDir, "scenarios.md"), "utf-8");
            kbContext += `\n## Scenarios\n\n${scenariosMd}\n`;
        } catch (err) {
            debugLog("Neither recipe.json nor scenarios.md is readable; generating without a data contract", { err });
        }
    }

    let features: Map<string, DiscoveredFeature> | undefined;
    if (!existingState) {
        features = await loadFeatures(input.outputDir);
        if (!features) {
            console.log("  Running feature discovery...");
            features = await runFeatureDiscovery({
                projectRoot: input.projectRoot,
                outputDir: input.outputDir,
                modelId: input.modelId,
                pages: input.pages,
            });
            console.log(`  Discovered ${features.size} sub-features`);
        } else {
            console.log(`  Loaded ${features.size} cached sub-features from features.json`);
        }
    }

    const preseedContext = existingState
        ? ""
        : await preseedQueue(state, input.projectRoot, input.pages, features ?? undefined);

    const resumeContext = existingState
        ? `\nYou are RESUMING a previous run. ${existingState.summary().tested} nodes tested, ${existingState.summary().totalTests} tests written. Call next_node to continue.`
        : "";

    const contextBlock = formatRetryGuidance(input.retryGuidance);

    let prompt = `Generate E2E test cases by processing every node in the queue.
${contextBlock}${kbContext}${resumeContext}${preseedContext}

The project codebase is at the working directory.

MANDATORY PROCESS:
1. Call next_node to get the first node
2. For EACH node returned by next_node:
   a. Read its source files and explore the surrounding codebase - use glob, grep, read_file to find ALL related components, utilities, and imports. Don't stop at the page file.
   b. Catalog every interactive element: buttons, inputs, toggles, forms, modals, tables, dropdowns
   c. Write tests PROPORTIONAL to the feature's actual complexity - the more interactive elements and workflows you find in the source, the more tests you write
   d. CRUD COMPLETENESS: if the source has Create/Edit/Delete for ANY entity, write tests for ALL of them
   e. OUTCOME VERIFICATION: after every action, navigate to where the result should be visible and ASSERT it
   f. After writing tests, call next_node to get the next node
   g. If a node has no testable behavior (utility, redirect): call next_node to skip it (auto-skipped)
3. When next_node returns done, call finish

Do NOT spend excessive time on any single node. Write tests for what you find, then move on.
Do NOT try to finish early. Process EVERY node via next_node until it returns done.`;

    // Steps one agent conversation may run before it is torn down and rebuilt.
    //
    // Primarily a work-sizing knob, kept modest as a memory precaution. The AI SDK
    // holds every step of a single `generate()` call alive for the whole call (the
    // conversation it re-sends each turn plus one step result per step, tool
    // results included), so a call that runs for thousands of steps holds a large
    // working set. Rebuilding the conversation per chunk caps that set; a node
    // takes a few dozen steps, so 400 still fits a worker's whole slice, and the
    // chunk loop resumes any node it did not reach - bounding it costs coverage
    // nothing. Whether this is load-bearing for memory is unconfirmed on current
    // runs; lower it if a large app regresses.
    const CHUNK_STEPS = 400;
    const MAX_STALE_CHUNKS = 3;
    let totalSteps = 0;

    const logger = createStepLogger("test-gen", CHUNK_STEPS);

    // Review the first pass of each test while generation is still going. Nothing
    // rewrites a test between being written and its first review, so that pass has
    // no reason to wait for the last node - and review is most of the step's wall
    // clock. The fix cycles below still run after generation: they delete and
    // rewrite files, which cannot overlap a generator that is also writing.
    const reviewDeadline = Date.now() + REVIEW_BUDGET_MS;
    const pipeline = new ReviewPipeline(input.outputDir, input.projectRoot, model, reviewDeadline);

    // What the run has already promised to cover. A node is an entry point rather
    // than a test, so two nodes can reach the same shared modal and each decide it
    // needs covering - claiming a test costs a sentence, writing one costs a whole
    // structured payload and several calls.
    //
    // With a flow ranking it is also where budget is enforced. Reserving each flow's
    // allowance up front and refusing at proposal time is what stops allocation from
    // being decided by scheduling order: a settings worker that starts first cannot
    // spend the allowance belonging to the flow the product is sold on.
    const flows = await loadFlows(input.outputDir);
    const budget = flows != null ? planBudget(flows, input.pages.size, targetTestCount(input.pages.size)) : undefined;
    // The reasoning behind the suite - pitch, tiering, risk, budget split - is
    // computed here and would otherwise be discarded after this one log line.
    // Push it into the dashboard so a human can judge whether the tiering is
    // right without opening a test file; headless runs print it as plain lines.
    if (flows != null && budget != null) {
        const plan = buildRunPlan(flows, budget);
        const store = getActiveStore();
        if (store != null) {
            store.setPlan(plan);
            store.pushActivity({
                call: "checkpoint",
                arg: `test plan ready - ${plan.total} tests across ${plan.flows.length} flows`,
            });
        } else {
            printPlanReasoning(plan);
        }
    } else if (getActiveStore() == null) {
        console.warn("  No flow ranking found; every page gets equal budget");
    }

    // The closed set every test's `flow` field must draw from. Undefined when there
    // is no ranking, which the schema and the registry both read as "do not enforce"
    // so degraded runs keep their permissive behaviour.
    const runFlowIds = budget != null ? planFlowIds(budget) : undefined;
    // The smoke floor is one test per PAGE, so the registry has to collapse a page
    // and its sub-features onto one key - the same page root the worker partition uses.
    const registry = new TestRegistry(model, budget, (nodeId) => pageRootOf(state, nodeId));

    /** Which flow's allowance a node draws from, via the route it sits on. */
    const flowForNode = (nodeId: string): string | undefined => {
        if (budget == null) return undefined;
        const route = state.nodes.get(nodeId)?.routePath;
        return route != null ? flowForRoute(budget, route) : undefined;
    };

    /**
     * Tell a worker what its slice is worth and, on a tier-1 flow, how to attack it.
     * Scoped to the worker rather than the system prompt so each agent sees only the
     * budget and the invariants of the flow it is actually writing for.
     */
    const withFlowBrief = (workerPrompt: string, worker: WorkerScope): string => {
        if (budget == null) return workerPrompt;
        const flowId = flowForNode(worker.id);
        const allowance = flowId != null ? budget.byFlow.get(flowId) : undefined;
        if (allowance == null) return workerPrompt;

        const brief =
            `\n\nThis page belongs to the "${allowance.name}" flow (tier ${allowance.tier}), which has a budget of ` +
            `${allowance.allowance} tests beyond one smoke test per page. Use \`flow: "${allowance.flowId}"\` in every ` +
            `test you write here, and pass that same id as \`flow\` when you call propose_tests. propose_tests will ` +
            `refuse once the budget is spent - that is the signal to stop, not a problem to work around.`;
        return `${workerPrompt}${brief}${renderRedTeamBrief(allowance) ?? ""}`;
    };

    const listDirectoryFn = await buildListDirectoryTool(input.projectRoot);

    // One agent config per worker: the tools close over the worker's scope, so
    // next_node hands out only that slice and never another worker's nodes.
    //
    // `stopOnDrain` ends a generation worker's tool loop the moment its own slice
    // is done, without waiting for the model to call finish - the reliable half of
    // the termination fix, since the model often keeps calling next_node forever.
    // It is off for the review-fix pass (below), which runs on the whole,
    // already-drained graph and would otherwise stop before doing any work.
    const buildAgentConfig = (worker: WorkerScope, opts: { stopOnDrain?: boolean } = {}) => ({
        id: "test-generator",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: CHUNK_STEPS,
        temperature: 0.3,
        shouldStop: opts.stopOnDrain ? () => state.hasDrained(worker) : undefined,
        tools: (heartbeat: () => void) => ({
            read_file: buildReadFileTool(input.projectRoot),
            read_output: buildReadFileTool(input.outputDir),
            glob: buildGlobTool(input.projectRoot, ignorePatterns),
            grep: buildGrepTool(input.projectRoot),
            bash: buildBashTool(input.projectRoot),
            list_directory: listDirectoryFn,
            write_test: buildWriteTestTool(
                state,
                input.outputDir,
                (test) => {
                    consecutiveRejections = 0;
                    pipeline.submit(test);
                },
                runFlowIds,
            ),
            create_folder: buildCreateFolderTool(input.outputDir),
            propose_tests: buildProposeTestsTool(registry, flowForNode),
            next_node: buildNextNodeTool(state, input.outputDir, worker),
            get_progress: buildGetProgressTool(state),
            spawn_researcher: buildSpawnResearcherTool(model, input.projectRoot, heartbeat),
            finish: buildFinishTool(worker),
        }),
        onStepFinish: (info: Parameters<typeof logger.log>[0]) => {
            logger.log(info);
            recordToolErrors(info.toolErrors);
            // Count real steps rather than adding CHUNK_STEPS per chunk: with the
            // drain stop a chunk usually ends well short of the cap, so the cap
            // would wildly over-report the work the run actually did.
            totalSteps++;

            const stats = state.summary();
            if (info.stepNumber > 0 && info.stepNumber % 10 === 0) {
                logger.checkpoint(
                    `${stats.tested} nodes tested, ${stats.totalTests} tests written, ${stats.queued} in queue`,
                );
            }
        },
    });

    // A write_test whose arguments fail validation is rejected before the tool
    // runs, so the model just tries again - and nothing bounds that. A rule the
    // model cannot satisfy therefore spends the entire step budget rejecting the
    // same test: one real run burned 680 attempts and $11 without writing a single
    // file, and reported no error at all. Consecutive rejections with nothing
    // written in between mean the loop is not converging, so stop and say so.
    let consecutiveRejections = 0;
    let lastRejection: string | undefined;

    function recordToolErrors(toolErrors: { name: string; error: unknown }[]): void {
        const writeErrors = toolErrors.filter((e) => e.name === "write_test");
        if (writeErrors.length === 0) return;

        consecutiveRejections += writeErrors.length;
        lastRejection = String(writeErrors.at(-1)?.error ?? "").slice(0, REJECTION_MESSAGE_CHARS);

        if (consecutiveRejections === MAX_CONSECUTIVE_REJECTIONS) {
            track("cli_write_test_rejection_loop", { rejections: consecutiveRejections });
            captureLog("error", `write_test has rejected ${consecutiveRejections} attempts in a row`, {
                source: "test-generator",
                rejections: consecutiveRejections,
                last_error: lastRejection,
            });
            console.error(
                `\n  write_test has rejected ${consecutiveRejections} attempts in a row without a test being written.\n` +
                    `  The model cannot satisfy a validation rule, so retrying will not converge:\n  ${lastRejection}\n`,
            );
        }
    }

    /**
     * Walk one slice of the graph to exhaustion.
     *
     * The chunk loop is per-worker: a slice that stalls is that slice stalling,
     * and its neighbours keep going. A worker's tool loop ends the moment its own
     * slice drains (`stopOnDrain`), so a chunk normally runs only as many steps as
     * that slice needs rather than to the step cap; the loop below repeats only
     * when a chunk was cut off by the cap with the worker's nodes still pending.
     * `hasDrained` is also what tells runAgent the worker is legitimately done, so
     * a drained worker is not nudged for "stopping without finishing".
     */
    async function runWorker(worker: WorkerScope, workerPrompt: string): Promise<void> {
        const config = buildAgentConfig(worker, { stopOnDrain: true });
        let staleChunks = 0;
        let lastTestCount = state.summary().totalTests;
        let prompt = workerPrompt;

        for (;;) {
            try {
                await runAgent(config, prompt, () => (state.hasDrained(worker) ? WORKER_SLICE_DRAINED : result));
            } catch (err) {
                console.log(`  [chunk] Agent error (will retry next chunk):\n${formatException(err)}`);
            }

            if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
                console.log(
                    `  [chunk] write_test is rejecting every attempt - stopping rather than burning the budget.`,
                );
                return;
            }

            const stats = state.summary();
            const mine = state.remainingFor(worker);

            if (stats.totalTests === lastTestCount) {
                staleChunks++;
                console.log(
                    `  [chunk] No progress in last ${CHUNK_STEPS} steps (stale ${staleChunks}/${MAX_STALE_CHUNKS})`,
                );
                if (staleChunks >= MAX_STALE_CHUNKS) {
                    console.log(
                        `  [chunk] Agent stuck - ${MAX_STALE_CHUNKS} consecutive chunks with no progress. Stopping.`,
                    );
                    return;
                }
            } else {
                staleChunks = 0;
            }

            lastTestCount = stats.totalTests;

            if (mine === 0) {
                console.log(`  [chunk] Queue empty after ${totalSteps} steps. Finishing.`);
                return;
            }

            console.log(
                `  [chunk] Continuing - ${stats.totalTests} tests, ${mine} queued for this worker, ${totalSteps} total steps`,
            );

            prompt = `You are RESUMING a previous run. ${stats.tested} nodes tested, ${stats.totalTests} tests written.
Call next_node to get the next node. Continue processing all remaining nodes.
IMPORTANT: Do NOT try to finish early. Process every node via next_node until it returns done.`;
        }
    }

    /**
     * Guarantee the smoke floor even when generation stopped short of a page.
     *
     * The affordability floor makes a page's first test always claimable, but a
     * page still ends untested if its worker crashed, terminated early (a stale or
     * rejection-looping chunk), or the model chose to skip it as "trivial". The
     * floor is not a judgement call - every page must be seen - so any page still
     * at zero after generation gets exactly one smoke test written here. Bounded to
     * the uncovered pages and the review deadline: a healthy run has none and pays
     * nothing, and a degenerate one cannot spin.
     */
    async function backfillUncoveredPages(): Promise<number> {
        const coveredRoots = new Set<string>();
        for (const [nodeId, paths] of state.testsWritten) {
            if (paths.length > 0) coveredRoots.add(pageRootOf(state, nodeId));
        }
        const uncovered = [...state.nodes.values()].filter((node) => node.depth === 0 && !coveredRoots.has(node.id));
        if (uncovered.length === 0) return 0;

        console.log(
            `  ${uncovered.length} page${uncovered.length === 1 ? "" : "s"} left with no test - writing a smoke test for each`,
        );
        track("cli_smoke_backfill", { pages: uncovered.length });
        captureLog("warn", `Backfilling the smoke floor for pages generation left uncovered`, {
            source: "test-generator",
            step: "smoke-backfill",
            pages: uncovered.length,
        });
        state.setPhase("smoke coverage");

        const before = state.allTestPaths().length;
        await runPool(
            uncovered,
            { limit: generationLimit, shouldContinue: () => Date.now() < reviewDeadline },
            (page) => backfillOnePage(page),
        );
        return state.allTestPaths().length - before;
    }

    async function backfillOnePage(page: FeatureNode): Promise<void> {
        const flowId = flowForNode(page.id);
        const flowGuidance =
            flowId != null
                ? `Use \`flow: "${flowId}"\` in the test.`
                : runFlowIds != null && runFlowIds.size > 0
                  ? `Use whichever of these flow ids fits the page best, copied verbatim: ${[...runFlowIds].join(", ")}.`
                  : "";

        let done = false;
        const finishResult: AgentResult = { success: true, artifacts: [], summary: "smoke test written" };
        const finish = tool({
            description: "Call once the single smoke test has been written.",
            inputSchema: z.object({ summary: z.string() }),
            execute: async () => {
                done = true;
                return { done: true };
            },
        });

        const label = page.routePath ?? page.name;
        const prompt = `Write exactly ONE smoke test proving the "${label}" page loads and its primary interactions work.

This page was left with no test at all. A smoke test is the coverage floor: navigate to the page, act on a primary element (click or type), and assert the page actually rendered the resulting effect. It is proof the page is not broken, not a deep feature test - write only one.

Source files: ${page.sourceFiles.join(", ") || "(none listed - use glob/grep to find the page)"}.
${page.description != null ? `This page's mission: "${page.description}".` : ""}

Read the source to find the real interactive elements, then call write_test once with folder "${page.id}" and nodeId "${page.id}". ${flowGuidance} Then call finish.`;

        const config = {
            id: "smoke-backfill",
            systemPrompt: SYSTEM_PROMPT,
            model,
            maxSteps: SMOKE_BACKFILL_STEPS,
            maxRetries: 1,
            temperature: 0.3,
            tools: () => ({
                read_file: buildReadFileTool(input.projectRoot),
                read_output: buildReadFileTool(input.outputDir),
                glob: buildGlobTool(input.projectRoot, ignorePatterns),
                grep: buildGrepTool(input.projectRoot),
                list_directory: listDirectoryFn,
                write_test: buildWriteTestTool(state, input.outputDir, (test) => pipeline.submit(test), runFlowIds),
                finish,
            }),
            onStepFinish: () => {},
        };

        try {
            await runAgent(config, prompt, () => (done ? finishResult : undefined));
        } catch (err) {
            console.warn(`  [smoke] Could not backfill ${page.name}: ${formatException(err)}`);
        }
    }

    // Generation is the serial two thirds of this step: on a measured run 65% of
    // the wall clock had exactly one call in flight, because one agent walked
    // every node in turn. Pages are independent - different source files,
    // different vocabulary - so they are walked at once, each by its own agent.
    const workers = partitionByPage(state);
    console.log(
        workers.length > 1
            ? `  Generating across ${workers.length} pages, ${describeConcurrency(Math.min(workers.length, generationLimit))}`
            : `  Generating`,
    );

    await runPool(workers, { limit: generationLimit }, (worker) =>
        runWorker(worker, withFlowBrief(workers.length > 1 ? scopedPrompt(worker, state) : prompt, worker)),
    );

    logger.summary();

    // The smoke floor is a guarantee, not a best effort: any page a worker never
    // reached or the model skipped is smoked here before the suite is finalized.
    const backfilled = await backfillUncoveredPages();
    if (backfilled > 0) {
        console.log(`  Backfilled ${backfilled} smoke test${backfilled === 1 ? "" : "s"} for uncovered pages`);
    }

    // Rebuild the run result from the final state, unconditionally. Per-worker
    // finish means the first worker to drain its slice sets `result` from a suite
    // that is only partly written, so its artifact list and summary would
    // under-report the whole run; refreshing here - after every worker and the
    // backfill - makes the returned result reflect the suite that actually landed.
    if (state.allTestPaths().length > 0) {
        const stats = state.summary();
        result = {
            success: true,
            artifacts: state.allTestPaths(),
            summary: `${stats.totalTests} tests written across ${stats.tested} nodes in ${totalSteps} steps.`,
        };
    }

    if (state.allTestPaths().length > 0) {
        state.setPhase("writing journey tests");
        const journeyCount = await generateJourneyTests(input.outputDir, model, input.projectRoot, runFlowIds);
        if (journeyCount > 0) {
            console.log(`  Generated ${journeyCount} journey tests`);
        }

        // Tests the review cycle removed that neither the fix agent nor the
        // restore could put back - a restore fails on a full disk, or on a
        // directory the cleanup pass pruned. Tracked by path, not counted, both
        // so a later cycle that does restore one can take it back out again and
        // so the index below can name them: a test that is absent from disk is
        // otherwise absent from the index too, and a log line nobody reads is
        // how these went missing unnoticed in the first place.
        const lostTests = new Set<string>();

        // The fix pass runs after every worker has drained, so it belongs to no
        // slice: it rewrites tests by path and never calls next_node.
        const fixAgentConfig = buildAgentConfig(ALL_NODES);

        // --- Review → Fix cycle (max MAX_REVIEW_CYCLES, inside REVIEW_BUDGET_MS) ---
        // Whatever the pipeline finished while generation ran. Cycle 1 reuses these
        // instead of re-reviewing, so its cost has already been paid in parallel.
        const pipelined = await pipeline.drain();
        if (pipelined.length > 0) {
            console.log(`  ${pipelined.length} tests were already reviewed during generation`);
        }

        // Tests that have already cleared every rubric. Nothing rewrites a passing
        // test, so later cycles have no new question to ask about one - and asking
        // anyway costs four agents per test and can flip the answer, which is what
        // stopped the loop converging.
        const settled = new Set<string>();

        for (let cycle = 0; cycle < MAX_REVIEW_CYCLES; cycle++) {
            if (Date.now() > reviewDeadline) {
                console.log(`  Review budget spent after ${cycle} cycle${cycle === 1 ? "" : "s"} - moving on`);
                track("cli_review_budget_exhausted", { cycles_completed: cycle });
                captureLog("warn", `Review budget spent - skipping the remaining review cycles`, {
                    source: "test-generator",
                    step: "review",
                    cycles_completed: cycle,
                    budget_minutes: REVIEW_BUDGET_MS / 60_000,
                });
                break;
            }

            console.log(`  Review cycle ${cycle + 1}/${MAX_REVIEW_CYCLES}`);
            state.setPhase(`review cycle ${cycle + 1}/${MAX_REVIEW_CYCLES}`);

            // The scan stops early enough that its findings can still be fixed
            // inside the same budget.
            const scanDeadline = Date.now() + Math.floor((reviewDeadline - Date.now()) * REVIEW_SCAN_SHARE);
            // The strip switches to the review ratio on runConsolidatedReview's
            // first onProgress call, which is the earliest point the total is
            // known. Until then setPhase above already relabels it with the
            // cycle, so the run never reads as idle.
            const reviewStartedAt = activeAgentNow() ?? Date.now();
            const reviewResult = await runConsolidatedReview(
                input.outputDir,
                input.projectRoot,
                model,
                scanDeadline,
                settled,
                cycle === 0 ? pipelined : [],
                (done, total) => state.setReviewProgress(done, total, reviewStartedAt),
            );
            for (const path of reviewResult.passedPaths) settled.add(path);

            console.log(
                `  Review: ${reviewResult.passed} passed, ${reviewResult.failed} failed ` +
                    `(${settled.size} settled overall)`,
            );

            if (reviewResult.feedback.length === 0) {
                console.log(`  All tests passed review - done`);
                break;
            }

            // Whether each outcome is reported is decided after it is known: a
            // spent overall budget discards these findings, a merely short scan
            // carries them into the fix phase below. Reporting the carry first
            // would count findings that the next line then throws away.
            const scanCutShort = reviewResult.ranOutOfTime;
            if (Date.now() > reviewDeadline) {
                console.log(`  Review budget spent - moving on`);
                track("cli_review_budget_exhausted", {
                    cycles_completed: cycle,
                    findings_discarded: reviewResult.feedback.length,
                });
                captureLog("warn", `Review budget spent - findings from this cycle were not fixed`, {
                    source: "test-generator",
                    step: "review",
                    cycles_completed: cycle,
                    findings_discarded: reviewResult.feedback.length,
                });
                break;
            }
            if (scanCutShort) {
                console.log(`  Review scan cut short - fixing the ${reviewResult.feedback.length} it did judge`);
                track("cli_review_scan_cut_short", {
                    cycles_completed: cycle,
                    findings_carried: reviewResult.feedback.length,
                });
                captureLog("warn", `Review scan cut short - some tests were left unreviewed`, {
                    source: "test-generator",
                    step: "review",
                    cycles_completed: cycle,
                    findings_carried: reviewResult.feedback.length,
                });
            }

            // Delete failing tests before feeding back to planner, so a rewrite
            // lands on a clean path. Each one is restored below if its fix agent
            // never wrote it back.
            // Independent paths, so delete them together rather than one await at
            // a time - the cycle can repeat over a suite of hundreds of failures.
            await Promise.all(
                reviewResult.feedback.map((fb) =>
                    unlink(fb.testPath).catch((err) => {
                        debugLog("Failing test was already gone before its fix pass", {
                            path: fb.relativePath,
                            err,
                        });
                    }),
                ),
            );

            // Fix in parallel - each test gets its own focused prompt
            console.log(`  Feeding ${reviewResult.feedback.length} tests back to planner for fixes`);

            let restored = 0;
            const fixBatchSize = MAX_CONCURRENCY;
            for (let i = 0; i < reviewResult.feedback.length; i += fixBatchSize) {
                const batch = reviewResult.feedback.slice(i, i + fixBatchSize);
                // Past the deadline every remaining test is restored rather than
                // fixed, which the loop below already does for free.
                const outOfTime = Date.now() > reviewDeadline;
                await Promise.all(
                    batch.map(async (fb) => {
                        if (!outOfTime) {
                            const fixPrompt = buildReviewFixPrompt(fb);
                            try {
                                // `result` is already set by the generation phase, so the nudge loop is
                                // skipped: the fix agent runs one pass and stops on finish instead of
                                // being force-nudged MAX_NUDGES times after every clean pass.
                                // One attempt only: a failed fix restores the original below, so a
                                // retry buys a marginally better test for 3x the wall clock.
                                await runAgent(
                                    { ...fixAgentConfig, maxSteps: 30, maxRetries: 1 },
                                    fixPrompt,
                                    () => result,
                                );
                            } catch (err) {
                                console.warn(
                                    `  [fix] Error fixing ${fb.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
                                );
                            }
                        }
                        if (await restoreDeletedTest(fb.testPath, fb.content)) {
                            restored++;
                            lostTests.delete(fb.relativePath);
                        } else if (!existsSync(fb.testPath)) {
                            // Neither the fix agent nor the restore produced a
                            // file. The test is gone from the suite, and only the
                            // index will say so.
                            lostTests.add(fb.relativePath);
                        } else {
                            lostTests.delete(fb.relativePath);
                        }
                    }),
                );
            }

            if (lostTests.size > 0) {
                console.warn(`  ${lostTests.size} test${lostTests.size === 1 ? "" : "s"} could not be put back`);
            }
            if (restored > 0) {
                console.log(
                    `  ${restored} test${restored === 1 ? "" : "s"} were not rewritten - restored the original`,
                );
                track("cli_review_tests_restored", { count: restored, cycle: cycle + 1 });
                captureLog("warn", `${restored} reviewed tests were not rewritten - restored the pre-review content`, {
                    source: "test-generator",
                    step: "review-fix",
                    count: restored,
                    cycle: cycle + 1,
                });
            }
            console.log(`  Fix pass complete`);

            // A scan that could not cover the suite once will not cover it on a
            // second pass with less budget left.
            if (scanCutShort) break;
        }

        // Restore the node-exploration sub-progress so the strip no longer
        // shows a review ratio after the review cycles are done.
        state.clearReviewProgress();

        // --- Final validation sweep: move structurally invalid tests to _invalid/ ---
        state.setPhase("checking every test");
        const allTestFiles = await glob(join(input.outputDir, TESTS_DIR, TEST_FILE_GLOB));
        // Each file is read and validated independently, so scan them together
        // rather than one await per file - a 199-test suite is 199 serial reads.
        const candidates = allTestFiles.filter((p) => isTestFile(p) && !p.includes(`/${INVALID_DIR}/`));
        const invalid = (
            await Promise.all(
                candidates.map(async (testPath) => {
                    const content = await readFile(testPath, "utf-8");
                    const validation = validateTestContent(content);
                    if (validation.valid) return undefined;
                    return { testPath, content, errors: validation.errors };
                }),
            )
        ).filter((entry) => entry != null);

        if (invalid.length > 0) {
            // Made once, not per file: the destination is the same directory for all.
            const invalidDir = join(input.outputDir, TESTS_DIR, INVALID_DIR);
            await mkdir(invalidDir, { recursive: true });
            await Promise.all(
                invalid.map(async ({ testPath, content, errors }) => {
                    const dest = join(invalidDir, basename(testPath));
                    const annotated = `<!-- VALIDATION ERRORS: ${errors.join("; ")} -->\n${content}`;
                    await writeFile(dest, annotated, "utf-8");
                    await unlink(testPath);
                }),
            );
        }
        const markedInvalid = invalid.length;
        if (markedInvalid > 0) {
            console.log(`  ${markedInvalid} tests still invalid after review cycles - moved to _invalid/`);
        }

        // --- Clean up empty directories ---
        const dirs = await glob(join(input.outputDir, TESTS_DIR, "**/"), {
            dot: false,
        });
        for (const dir of dirs.sort((a, b) => b.length - a.length)) {
            try {
                await rmdir(dir);
            } catch (err) {
                debugLog("Leaving a non-empty test directory in place", { dir, err });
            }
        }

        // The only index write, once the suite has stopped moving: journey tests
        // added, review deletions settled, quarantine swept, empty folders pruned.
        // Writing it earlier only produced a file that disagreed with the suite
        // beside it until this point overwrote it.
        await generateIndex(input.outputDir, state, { lost: lostTests });
    }

    // Output review happens live in the TUI - the run no longer stops to ask.
    const reviewed = result;

    return (
        reviewed ?? {
            success: false,
            artifacts: [],
            summary: "Test generator did not produce a result",
        }
    );
}

function buildReviewFixPrompt(fb: TestReviewFeedback): string {
    const failedDetails = fb.failedDimensions
        .map((dim) => {
            const d = fb.dimensions[dim];
            if (!d) return `- **${dim}**: no evidence available`;
            return `- **${dim}**: ${d.evidence}${d.suggestion ? `\n  Suggestion: ${d.suggestion}` : ""}`;
        })
        .join("\n");

    const segments = fb.relativePath.split("/");
    const filename = segments.pop() ?? fb.relativePath;
    const folder = segments.join("/");

    return `Fix this ONE test that failed review. The reviewer found specific problems - read the feedback carefully and use your tools to investigate and fix.

## Test: ${fb.relativePath}
\`\`\`
${fb.content}
\`\`\`

## Review feedback (failed dimensions):
${failedDetails}

## Instructions:
1. Read the source files for this feature to understand what the real UI looks like
2. If the feedback mentions scenario data issues, use read_output to read scenarios.md and use ONLY values that exist there
3. Fix the specific issues the reviewer identified - use the evidence and suggestions
4. Rewrite the test using write_test with folder "${folder}" and filename "${filename}" - the same path it already has. Do not rename or move it. The tool validates structure automatically.
5. If the test is unfixable (the feature doesn't support the intended behavior), skip it and call finish

IMPORTANT: Focus ONLY on this test. Do not write new tests or modify other files.`;
}

async function generateJourneyTests(
    outputDir: string,
    model: LanguageModel,
    projectRoot: string,
    validFlowIds?: ReadonlySet<string>,
): Promise<number> {
    const logger = createStepLogger("journeys", 50);

    let autonomaMd = "";
    let scenariosMd = "";
    try {
        autonomaMd = await readFile(join(outputDir, "AUTONOMA.md"), "utf-8");
    } catch (err) {
        debugLog("AUTONOMA.md not present for journey generation", { err });
    }
    try {
        scenariosMd = await readFile(join(outputDir, "scenarios.md"), "utf-8");
    } catch (err) {
        debugLog("scenarios.md not present for journey generation", { err });
    }

    if (!autonomaMd) return 0;

    const existingTests = await glob(join(outputDir, TESTS_DIR, TEST_FILE_GLOB));
    const existingTitles: string[] = [];
    for (const t of existingTests) {
        if (!isTestFile(t)) continue;
        const content = await readFile(t, "utf-8");
        const titleMatch = content.match(/title:\s*"([^"]+)"/);
        if (titleMatch) existingTitles.push(titleMatch[1]!);
    }

    const featuresContext = "";

    const journeyPrompt = `Generate cross-feature JOURNEY tests that traverse the core product flow end-to-end.

## Knowledge Base
${autonomaMd}
${featuresContext}

## Scenarios (EXACT data in the database)
${scenariosMd}

## Existing test titles (do NOT duplicate)
${existingTitles.join("\n")}

## Instructions

Read the core_flows from the Knowledge Base above. For each core feature, identify how it connects to other features in a real user workflow. Generate journey tests that traverse 2+ core features end-to-end.

Each journey test:
- Spans 2+ features/pages in sequence
- Has 8-15 steps (longer than feature tests)
- Uses EXACT data values from scenarios.md - NEVER use "Dynamic:", "{variable}", or "e.g."
- Has criticality: critical
- Has scenario: standard
- Includes an **Intent**: section explaining the cross-feature flow being tested
- Verifies that the OUTPUT of one feature is correctly consumed by the NEXT feature
- Goes in the "${JOURNEY_NODE_ID}" folder

Write 5-8 journey tests using the write_test tool with folder "${JOURNEY_NODE_ID}" and nodeId "${JOURNEY_NODE_ID}". Then call finish.`;

    const ignorePatterns = await loadGitignorePatterns(projectRoot);
    const journeyState = new CoverageState({ stateFile: JOURNEY_STATE_FILE, reportsProgress: false });
    journeyState.enqueue({
        id: JOURNEY_NODE_ID,
        name: "Journey Tests",
        sourceFiles: [],
        parentId: undefined,
        depth: 0,
        status: "queued",
    });
    // Mark the node as being explored before the agent runs. This phase has no
    // next_node tool, so nothing else ever would - and write_test resolves an
    // unrecognized nodeId against the node in progress. The prompt names the id,
    // so this is the safety net for an agent that sends something else (a
    // filename, usually) rather than the path every write takes.
    journeyState.nextNode();

    let journeyResult: AgentResult | undefined;
    const journeyFinish = tool({
        description: "Signal journey generation is complete.",
        inputSchema: z.object({ summary: z.string() }),
        execute: async (finishInput) => {
            journeyResult = {
                success: true,
                artifacts: journeyState.allTestPaths(),
                summary: finishInput.summary,
            };
            return { done: true, count: journeyState.allTestPaths().length };
        },
    });

    const config = {
        id: "journey-gen",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: 50,
        temperature: 0.3,
        tools: () => ({
            read_file: buildReadFileTool(projectRoot),
            read_output: buildReadFileTool(outputDir),
            glob: buildGlobTool(projectRoot, ignorePatterns),
            write_test: buildWriteTestTool(journeyState, outputDir, undefined, validFlowIds),
            create_folder: buildCreateFolderTool(outputDir),
            finish: journeyFinish,
        }),
        onStepFinish: (info: Parameters<typeof logger.log>[0]) => logger.log(info),
    };

    try {
        await runAgent(config, journeyPrompt, () => journeyResult);
    } catch (err) {
        console.error(`Journey generator error:\n${formatException(err)}`);
    }

    logger.summary();
    return journeyState.allTestPaths().length;
}
