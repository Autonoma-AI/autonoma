import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type LanguageModel, tool } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../config";
import { type AgentResult, formatRetryGuidance, runAgent } from "../../core/agent";
import { formatContext, type ProjectContext } from "../../core/context";
import { createStepLogger } from "../../core/display";
import { formatException } from "../../core/errors";
import { loadGitignorePatterns } from "../../core/gitignore";
import { getModel } from "../../core/model";
import { runConsolidatedReview, type TestReviewFeedback } from "./review";

const MAX_CONCURRENCY = 8;
import { glob } from "glob";
import { debugLog } from "../../core/debug";
import { buildBashTool, buildGlobTool, buildGrepTool, buildListDirectoryTool, buildReadFileTool } from "../../tools";
import { type DiscoveredFeature, loadFeatures, runFeatureDiscovery } from "../00b-feature-discovery/index";
import { CoverageState, type FeatureNode, loadBfsState } from "./graph";
import { SYSTEM_PROMPT } from "./prompt";
import {
    buildCreateFolderTool,
    buildGetProgressTool,
    buildNextNodeTool,
    buildSpawnResearcherTool,
    buildWriteTestTool,
} from "./tools";
import { validateTestContent } from "./validation";

export interface TestGeneratorInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    config?: AppConfig;
    projectContext?: ProjectContext;
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
            };
            if (state.enqueue(node)) seeded++;
        }
    }

    return seeded > 0
        ? `\nPre-seeded: ${seeded} nodes (pages + sub-features). Call next_node to start processing them one at a time.`
        : "";
}

export async function runTestGenerator(input: TestGeneratorInput): Promise<AgentResult> {
    const model = getModel(input.modelId);

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

            await generateIndex(input.outputDir, state);

            return {
                ...stats,
                message: "Test generation complete. INDEX.md written.",
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

    try {
        const scenariosMd = await readFile(join(input.outputDir, "scenarios.md"), "utf-8");
        kbContext += `\n## Scenarios\n\n${scenariosMd}\n`;
    } catch {
        /* scenarios not available */
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

    const contextBlock =
        (input.projectContext ? "\n" + formatContext(input.projectContext) + "\n" : "") +
        formatRetryGuidance(input.retryGuidance);

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
            write_test: buildWriteTestTool(state, input.outputDir),
            create_folder: buildCreateFolderTool(input.outputDir),
            next_node: buildNextNodeTool(state, input.outputDir),
            get_progress: buildGetProgressTool(state),
            spawn_researcher: buildSpawnResearcherTool(model, input.projectRoot, heartbeat),
            finish: finishTool,
        }),
        onStepFinish: (info: Parameters<typeof logger.log>[0]) => {
            logger.log(info);

            const stats = state.summary();
            if (info.stepNumber > 0 && info.stepNumber % 10 === 0) {
                logger.checkpoint(
                    `${stats.tested} nodes tested, ${stats.totalTests} tests written, ${stats.queued} in queue`,
                );
            }
        },
    };

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
        await generateIndex(input.outputDir, state);
        const stats = state.summary();
        result = {
            success: true,
            artifacts: state.allTestPaths(),
            summary: `${stats.totalTests} tests written across ${stats.tested} nodes in ${totalSteps} steps.`,
        };
    }

    if (state.allTestPaths().length > 0) {
        const journeyCount = await generateJourneyTests(input.outputDir, model, input.projectRoot);
        if (journeyCount > 0) {
            console.log(`  Generated ${journeyCount} journey tests`);
        }

        // --- Review → Fix cycle (max MAX_REVIEW_CYCLES) ---
        const MAX_REVIEW_CYCLES = 4;

        for (let cycle = 0; cycle < MAX_REVIEW_CYCLES; cycle++) {
            console.log(`  Review cycle ${cycle + 1}/${MAX_REVIEW_CYCLES}`);

            const reviewResult = await runConsolidatedReview(input.outputDir, input.projectRoot, model);

            console.log(`  Review: ${reviewResult.passed} passed, ${reviewResult.failed} failed`);

            if (reviewResult.feedback.length === 0) {
                console.log(`  All tests passed review - done`);
                break;
            }

            // Delete failing tests before feeding back to planner
            for (const fb of reviewResult.feedback) {
                try {
                    await unlink(fb.testPath);
                } catch {
                    /* already gone */
                }
            }

            // Fix in parallel - each test gets its own focused prompt
            console.log(`  Feeding ${reviewResult.feedback.length} tests back to planner for fixes`);

            const fixBatchSize = MAX_CONCURRENCY;
            for (let i = 0; i < reviewResult.feedback.length; i += fixBatchSize) {
                const batch = reviewResult.feedback.slice(i, i + fixBatchSize);
                await Promise.all(
                    batch.map(async (fb) => {
                        const fixPrompt = buildReviewFixPrompt(fb);
                        try {
                            // `result` is already set by the generation phase, so the nudge loop is
                            // skipped: the fix agent runs one pass and stops on finish instead of
                            // being force-nudged MAX_NUDGES times after every clean pass.
                            await runAgent({ ...agentConfig, maxSteps: 30 }, fixPrompt, () => result);
                        } catch (err) {
                            console.warn(
                                `  [fix] Error fixing ${fb.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
                            );
                        }
                    }),
                );
            }

            console.log(`  Fix pass complete`);
        }

        // --- Final validation sweep: move structurally invalid tests to _invalid/ ---
        const allTestFiles = await glob(join(input.outputDir, "qa-tests", "**/*.md"));
        let markedInvalid = 0;
        for (const testPath of allTestFiles) {
            if (basename(testPath) === "INDEX.md") continue;
            if (testPath.includes("/_invalid/")) continue;
            const content = await readFile(testPath, "utf-8");
            const validation = validateTestContent(content);
            if (!validation.valid) {
                const invalidDir = join(input.outputDir, "qa-tests", "_invalid");
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
        const dirs = await glob(join(input.outputDir, "qa-tests", "**/"), {
            dot: false,
        });
        for (const dir of dirs.sort((a, b) => b.length - a.length)) {
            try {
                await rmdir(dir);
            } catch {
                /* not empty */
            }
        }
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
4. Rewrite the test using write_test - the tool validates structure automatically
5. If the test is unfixable (the feature doesn't support the intended behavior), skip it and call finish

IMPORTANT: Focus ONLY on this test. Do not write new tests or modify other files.`;
}

async function generateIndex(outputDir: string, state: CoverageState): Promise<void> {
    const testsByFolder = new Map<string, string[]>();

    for (const paths of state.testsWritten.values()) {
        for (const p of paths) {
            const parts = p.split("/");
            if (parts.length >= 3) {
                const folder = parts[1]!;
                const existing = testsByFolder.get(folder) ?? [];
                existing.push(p);
                testsByFolder.set(folder, existing);
            }
        }
    }

    const stats = state.summary();
    const folders = [...testsByFolder.entries()].map(([name, tests]) => ({
        name,
        test_count: tests.length,
    }));

    const critCounts = new Map([
        ["critical", 0],
        ["high", 0],
        ["mid", 0],
        ["low", 0],
    ]);
    const flowCounts = new Map<string, number>();
    let totalSteps = 0;
    let totalInteractions = 0;

    for (const paths of state.testsWritten.values()) {
        for (const p of paths) {
            try {
                const content = await readFile(join(outputDir, p), "utf-8");
                const critMatch = content.match(/criticality:\s*(\w+)/);
                const critVal = critMatch?.[1] ?? "";
                if (critCounts.has(critVal)) critCounts.set(critVal, (critCounts.get(critVal) ?? 0) + 1);
                const flowMatch = content.match(/flow:\s*"([^"]+)"/);
                const flowVal = flowMatch?.[1];
                if (flowVal) flowCounts.set(flowVal, (flowCounts.get(flowVal) ?? 0) + 1);
                const stepMatches = content.match(/^\d+\.\s+(click|type|scroll|assert|hover|drag|read|refresh):/gm);
                if (stepMatches) totalSteps += stepMatches.length;
                const interactionMatches = content.match(/^\d+\.\s+(click|type|drag):/gm);
                if (interactionMatches) totalInteractions += interactionMatches.length;
            } catch {
                /* file may not exist */
            }
        }
    }

    const avgSteps = stats.totalTests > 0 ? (totalSteps / stats.totalTests).toFixed(1) : "0";

    let content = `---
total_tests: ${stats.totalTests}
total_folders: ${folders.length}
avg_steps_per_test: ${avgSteps}
total_interactions: ${totalInteractions}
criticality:
  critical: ${critCounts.get("critical") ?? 0}
  high: ${critCounts.get("high") ?? 0}
  mid: ${critCounts.get("mid") ?? 0}
  low: ${critCounts.get("low") ?? 0}
folders:
${folders.map((f) => `  - name: "${f.name}"\n    test_count: ${f.test_count}`).join("\n")}
---

# Test Suite Index

Generated by BFS exploration. ${stats.tested} nodes tested, ${stats.skipped} skipped.

## Folders

| Folder | Tests |
|--------|-------|
${folders.map((f) => `| ${f.name} | ${f.test_count} |`).join("\n")}

## All Tests

${[...testsByFolder.entries()].flatMap(([_folder, tests]) => tests.map((t) => `- \`${t}\``)).join("\n")}
`;

    await writeFile(join(outputDir, "qa-tests", "INDEX.md"), content, "utf-8");
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

    const existingTests = await glob(join(outputDir, "qa-tests", "**/*.md"));
    const existingTitles: string[] = [];
    for (const t of existingTests) {
        if (basename(t) === "INDEX.md") continue;
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
- Goes in the "journeys" folder

Write 5-8 journey tests using the write_test tool with folder "journeys". Then call finish.`;

    const ignorePatterns = await loadGitignorePatterns(projectRoot);
    const journeyState = new CoverageState();
    journeyState.enqueue({
        id: "journeys",
        name: "Journey Tests",
        sourceFiles: [],
        parentId: undefined,
        depth: 0,
        status: "queued",
    });

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
