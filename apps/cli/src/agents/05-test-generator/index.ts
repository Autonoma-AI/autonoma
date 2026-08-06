import { existsSync } from "node:fs";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type LanguageModel, tool } from "ai";
import { glob } from "glob";
import { z } from "zod";
import type { AppConfig } from "../../config";
import { type AgentResult, formatRetryGuidance, runAgent } from "../../core/agent";
import { track } from "../../core/analytics";
import { debugLog } from "../../core/debug";
import { createStepLogger } from "../../core/display";
import { formatException } from "../../core/errors";
import { loadGitignorePatterns } from "../../core/gitignore";
import { captureLog } from "../../core/logs";
import { getModel } from "../../core/model";
import { activeAgentNow } from "../../core/progress";
import { INVALID_DIR, isTestFile, TEST_FILE_GLOB, TESTS_DIR } from "../../core/test-files";
import { buildBashTool, buildGlobTool, buildGrepTool, buildListDirectoryTool, buildReadFileTool } from "../../tools";
import { type DiscoveredFeature, loadFeatures, runFeatureDiscovery } from "../00b-feature-discovery/index";
import { CoverageState, type FeatureNode, JOURNEY_STATE_FILE, loadBfsState } from "./graph";
import { SYSTEM_PROMPT } from "./prompt";
import { loadRecipeContext } from "./recipe-context";
import { restoreDeletedTest } from "./restore-deleted-test";
import { runConsolidatedReview, type TestReviewFeedback } from "./review";
import { ReviewPipeline } from "./review-pipeline";
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

async function preseedQueue(
    state: CoverageState,
    projectRoot: string,
    pages: Map<string, PageEntry>,
    features?: Map<string, DiscoveredFeature>,
): Promise<string> {
    let seeded = 0;

    const pageIdByPath = new Map<string, string>();

    for (const [absolutePath, page] of pages) {
        const routeSegments = page.route
            .split("/")
            .filter(Boolean)
            .map((s) => s.replace(/[[\]$:]/g, "").replace(/\..*$/, "") || "param");

        if (routeSegments.length === 0) continue;

        const id = routeSegments.join("-");
        const name = routeSegments
            .map((s) => s.replace(/-/g, " ").replace(/\bparam\b/, "[id]"))
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(" / ");

        const relPath = absolutePath.startsWith(projectRoot)
            ? absolutePath.slice(projectRoot.length).replace(/^\//, "")
            : page.path;

        pageIdByPath.set(absolutePath, id);

        const node: FeatureNode = {
            id,
            name,
            routePath: page.route.startsWith("/") ? page.route : `/${page.route}`,
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
            const parentId = pageIdByPath.get(feature.parentPagePath) ?? undefined;
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

export async function runTestGenerator(input: TestGeneratorInput): Promise<AgentResult> {
    const model = input.model ?? getModel(input.modelId);

    const ignorePatterns = await loadGitignorePatterns(input.projectRoot);
    const existingState = await loadBfsState(input.outputDir);
    const state = existingState ?? new CoverageState();

    let result: AgentResult | undefined;

    const finishTool = tool({
        description: "Call when the BFS queue is empty and all routes have been explored.",
        inputSchema: z.object({
            summary: z.string().describe("Coverage summary"),
        }),
        execute: async (finishInput) => {
            const stats = state.summary();
            const totalProcessed = stats.tested;
            if (stats.queued > 0) {
                return {
                    error: `Cannot finish: ${stats.queued} nodes still in queue. Process them first.`,
                };
            }
            if (totalProcessed < 10 && stats.totalNodes > 10) {
                return {
                    error: `Cannot finish: only ${totalProcessed} of ${stats.totalNodes} nodes were tested. ${stats.skipped} were skipped. Call next_node to continue processing.`,
                };
            }

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
    } catch {
        /* KB not available */
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

    const CHUNK_STEPS = 3000;
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

    const listDirectoryFn = await buildListDirectoryTool(input.projectRoot);
    const agentConfig = {
        id: "test-generator",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: CHUNK_STEPS,
        temperature: 0.3,
        tools: (heartbeat: () => void) => ({
            read_file: buildReadFileTool(input.projectRoot),
            read_output: buildReadFileTool(input.outputDir),
            glob: buildGlobTool(input.projectRoot, ignorePatterns),
            grep: buildGrepTool(input.projectRoot),
            bash: buildBashTool(input.projectRoot),
            list_directory: listDirectoryFn,
            write_test: buildWriteTestTool(state, input.outputDir, (test) => {
                consecutiveRejections = 0;
                pipeline.submit(test);
            }),
            create_folder: buildCreateFolderTool(input.outputDir),
            next_node: buildNextNodeTool(state, input.outputDir),
            get_progress: buildGetProgressTool(state),
            spawn_researcher: buildSpawnResearcherTool(model, input.projectRoot, heartbeat),
            finish: finishTool,
        }),
        onStepFinish: (info: Parameters<typeof logger.log>[0]) => {
            logger.log(info);
            recordToolErrors(info.toolErrors);

            const stats = state.summary();
            if (info.stepNumber > 0 && info.stepNumber % 10 === 0) {
                logger.checkpoint(
                    `${stats.tested} nodes tested, ${stats.totalTests} tests written, ${stats.queued} in queue`,
                );
            }
        },
    };

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

    let staleChunks = 0;
    let lastTestCount = state.summary().totalTests;

    while (!result) {
        try {
            await runAgent(agentConfig, prompt, () => result);
        } catch (err) {
            console.log(`  [chunk] Agent error (will retry next chunk):\n${formatException(err)}`);
        }

        totalSteps += CHUNK_STEPS;

        if (result) break;

        if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
            console.log(`  [chunk] write_test is rejecting every attempt - stopping rather than burning the budget.`);
            break;
        }

        const stats = state.summary();
        const newTests = stats.totalTests - lastTestCount;

        if (newTests === 0) {
            staleChunks++;
            console.log(
                `  [chunk] No progress in last ${CHUNK_STEPS} steps (stale ${staleChunks}/${MAX_STALE_CHUNKS})`,
            );
            if (staleChunks >= MAX_STALE_CHUNKS) {
                console.log(
                    `  [chunk] Agent stuck - ${MAX_STALE_CHUNKS} consecutive chunks with no progress. Stopping.`,
                );
                break;
            }
        } else {
            staleChunks = 0;
        }

        lastTestCount = stats.totalTests;

        if (stats.queued === 0 && stats.tested > 0) {
            console.log(`  [chunk] Queue empty after ${totalSteps} steps. Finishing.`);
            break;
        }

        console.log(
            `  [chunk] Continuing - ${stats.totalTests} tests, ${stats.queued} queued, ${totalSteps} total steps`,
        );

        prompt = `You are RESUMING a previous run. ${stats.tested} nodes tested, ${stats.totalTests} tests written.
Call next_node to get the next node. Continue processing all remaining nodes.
IMPORTANT: Do NOT try to finish early. Process every node via next_node until it returns done.`;
    }

    logger.summary();

    if (!result && state.allTestPaths().length > 0) {
        const stats = state.summary();
        result = {
            success: true,
            artifacts: state.allTestPaths(),
            summary: `${stats.totalTests} tests written across ${stats.tested} nodes in ${totalSteps} steps.`,
        };
    }

    if (state.allTestPaths().length > 0) {
        state.setPhase("writing journey tests");
        const journeyCount = await generateJourneyTests(input.outputDir, model, input.projectRoot);
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
            for (const fb of reviewResult.feedback) {
                try {
                    await unlink(fb.testPath);
                } catch (err) {
                    debugLog("Failing test was already gone before its fix pass", { path: fb.relativePath, err });
                }
            }

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
                                    { ...agentConfig, maxSteps: 30, maxRetries: 1 },
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
        let markedInvalid = 0;
        for (const testPath of allTestFiles) {
            if (!isTestFile(testPath)) continue;
            if (testPath.includes(`/${INVALID_DIR}/`)) continue;
            const content = await readFile(testPath, "utf-8");
            const validation = validateTestContent(content);
            if (!validation.valid) {
                const invalidDir = join(input.outputDir, TESTS_DIR, INVALID_DIR);
                await mkdir(invalidDir, { recursive: true });
                const dest = join(invalidDir, basename(testPath));
                const annotated = `<!-- VALIDATION ERRORS: ${validation.errors.join("; ")} -->\n${content}`;
                await writeFile(dest, annotated, "utf-8");
                await unlink(testPath);
                markedInvalid++;
            }
        }
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

async function generateJourneyTests(outputDir: string, model: LanguageModel, projectRoot: string): Promise<number> {
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
            write_test: buildWriteTestTool(journeyState, outputDir),
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
