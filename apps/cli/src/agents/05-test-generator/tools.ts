import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasToolCall, type LanguageModel, stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { track } from "../../core/analytics";
import { debugLog } from "../../core/debug";
import { captureLog } from "../../core/logs";
import { AI_MAX_RETRIES } from "../../core/model";
import { TEST_FILE_EXT, TESTS_DIR, normalizeTestFilename } from "../../core/test-files";
import { buildBashTool, buildGlobTool, buildGrepTool, buildReadFileTool } from "../../tools";
import { ALL_NODES, type CoverageState, saveBfsState, type WorkerScope } from "./graph";
import type { WrittenTest } from "./review";
import { buildTestSpecSchema, renderTestMarkdown } from "./test-spec";

/**
 * @param validFlowIds The closed set of flow ids a test's `flow` field may use.
 * Empty/absent leaves the field permissive - the journey pass and no-ranking runs
 * pass nothing, so their behaviour is unchanged; a ranked run injects the set so a
 * paraphrased flow id is rejected by the schema before the file is ever written.
 */
export function buildWriteTestTool(
    state: CoverageState,
    outputDir: string,
    onWritten?: (test: WrittenTest) => void,
    validFlowIds?: ReadonlySet<string>,
) {
    return tool({
        description:
            "Write one test to qa-tests/{folder}/{filename}.md. " +
            "You supply the test's parts; the file is rendered for you, so do not write markdown or frontmatter yourself.",
        inputSchema: z.object({
            folder: z.string().describe("Subfolder name under qa-tests/"),
            filename: z
                .string()
                .describe(`File name ending in ${TEST_FILE_EXT} (e.g. login-valid-credentials${TEST_FILE_EXT})`),
            nodeId: z
                .string()
                .describe(
                    "The id next_node returned for this feature, copied verbatim. Not a re-slugged version of it, not a folder path, not the test filename.",
                ),
            test: buildTestSpecSchema(validFlowIds),
        }),
        execute: async (input) => {
            const content = renderTestMarkdown(input.test);
            const relPath = join(TESTS_DIR, input.folder, normalizeTestFilename(input.filename));
            const absPath = join(outputDir, relPath);

            const nodeId = state.resolveNodeId(input.nodeId, relPath);
            if (nodeId == null) {
                const stats = state.summary();
                // The refusal costs the run a test, so it needs to be countable
                // and not only readable: the graph shape separates "the node loop
                // never started" from "it already drained".
                track("cli_write_test_node_id_rejected", {
                    total_nodes: stats.totalNodes,
                    queued: stats.queued,
                });
                captureLog("warn", `write_test sent an unknown nodeId for a test no node owns`, {
                    source: "test-generator",
                    given: input.nodeId,
                    path: relPath,
                });
                return {
                    error:
                        `Unknown nodeId "${input.nodeId}", and no node owns ${relPath} or is being explored. ` +
                        `Call next_node first and pass back the id it returns, verbatim.`,
                };
            }

            try {
                await mkdir(dirname(absPath), { recursive: true });
                await writeFile(absPath, content, "utf-8");
                state.markTested(nodeId, [relPath]);
                await saveBfsState(outputDir, state);

                // The agent's own caveats about this test. Kept out of the file
                // (the markdown is a product contract, and it bans parenthetical
                // commentary) but recorded, so "I could not tell what this toggle
                // defaults to" reaches a human instead of becoming a silent guess.
                const notes = input.test.notes?.trim();
                if (notes != null && notes !== "") {
                    track("cli_write_test_notes", { node_id: nodeId });
                    captureLog("info", `Test author flagged an uncertainty: ${notes}`, {
                        source: "test-generator",
                        path: relPath,
                        node_id: nodeId,
                    });
                }

                // Handed over in memory: the reviewer needs exactly the content just
                // rendered, and `flow` is a field of the spec rather than something to
                // re-parse out of the frontmatter built from it. The path is relative
                // to the TESTS dir, matching the key the review side uses everywhere.
                onWritten?.({
                    relativePath: join(input.folder, normalizeTestFilename(input.filename)),
                    content,
                    flow: input.test.flow,
                });
                if (nodeId !== input.nodeId) {
                    debugLog("write_test received an unknown nodeId; attributed it to the current node", {
                        given: input.nodeId,
                        resolved: nodeId,
                        path: relPath,
                    });
                    // Same shape as the rejection, so the recovered and refused
                    // rates are comparable against the same graph state.
                    const stats = state.summary();
                    track("cli_write_test_node_id_corrected", {
                        total_nodes: stats.totalNodes,
                        queued: stats.queued,
                    });
                    captureLog("warn", `write_test sent an unknown nodeId - recorded under the node being explored`, {
                        source: "test-generator",
                        given: input.nodeId,
                        resolved: nodeId,
                        path: relPath,
                    });
                    return {
                        path: relPath,
                        title: input.test.title,
                        note:
                            `nodeId "${input.nodeId}" is not a known node - recorded under "${nodeId}". ` +
                            `Pass the id returned by next_node verbatim.`,
                    };
                }
                return { path: relPath, title: input.test.title };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { error: `Failed to write test: ${message}` };
            }
        },
    });
}

export function buildCreateFolderTool(outputDir: string) {
    return tool({
        description: "Create a folder under qa-tests/ for organizing tests.",
        inputSchema: z.object({
            folder: z.string().describe("Folder name (kebab-case)"),
        }),
        execute: async (input) => {
            const absPath = join(outputDir, TESTS_DIR, input.folder);
            try {
                await mkdir(absPath, { recursive: true });
                return { path: join(TESTS_DIR, input.folder) };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { error: `Failed to create folder: ${message}` };
            }
        },
    });
}

export function buildNextNodeTool(state: CoverageState, outputDir: string, worker: WorkerScope = ALL_NODES) {
    return tool({
        description:
            "Get the next node to write tests for. If you called next_node before " +
            "without writing any tests (via write_test), the previous node is auto-skipped. " +
            "Returns done:true when all nodes are processed.",
        inputSchema: z.object({}),
        execute: async () => {
            const next = state.nextNode(worker);
            await saveBfsState(outputDir, state);
            if (!next) {
                const stats = state.summary();
                return {
                    done: true,
                    message: `All ${stats.totalNodes} nodes processed (${stats.tested} tested, ${stats.skipped} skipped, ${stats.totalTests} tests). Call finish.`,
                };
            }
            return {
                node: {
                    id: next.node.id,
                    name: next.node.name,
                    routePath: next.node.routePath,
                    sourceFiles: next.node.sourceFiles,
                    parentId: next.node.parentId,
                    depth: next.node.depth,
                    // The node's mission and its discovered element count. Every test
                    // for this node has to verify the mission; the element count is
                    // what "test depth proportional to complexity" is measured against.
                    mission: next.node.description,
                    interactiveElements: next.node.interactiveElements,
                },
                remaining: next.remaining,
                instruction:
                    `Explore "${next.node.name}": read its source files, find all interactive elements, then write tests with write_test. ` +
                    (next.node.description != null
                        ? `This node's MISSION is: "${next.node.description}". At least one test must directly assert that mission's outcome. `
                        : "") +
                    "If no tests are needed after reading the source (e.g. utility route, redirect), call next_node to skip.",
            };
        },
    });
}

export function buildGetProgressTool(state: CoverageState) {
    return tool({
        description: "Check how many nodes have been tested vs how many remain.",
        inputSchema: z.object({}),
        execute: async () => {
            const stats = state.summary();
            const nodes = [...state.nodes.values()].map((n) => ({
                id: n.id,
                name: n.name,
                status: n.status,
                testCount: state.testsWritten.get(n.id)?.length ?? 0,
            }));
            return { ...stats, nodes };
        },
    });
}

export function buildSpawnResearcherTool(model: LanguageModel, workingDirectory: string, onHeartbeat?: () => void) {
    return tool({
        description:
            "Spawn a research subagent to read and analyze source files without polluting your context. " +
            "Use for complex sub-features where you don't want to read 20 files yourself.",
        inputSchema: z.object({
            instruction: z.string().describe("What to research - be specific about files and what to look for"),
        }),
        execute: async (input) => {
            const resultSchema = z.object({
                findings: z.string().describe("Summary of what was found"),
            });

            let result: z.infer<typeof resultSchema> | undefined;

            const subagent = new ToolLoopAgent({
                model,
                maxRetries: AI_MAX_RETRIES,
                instructions:
                    "You are a code researcher. Read the files specified in your instruction, " +
                    "analyze them, and call finish with a summary of what you found. " +
                    "Focus on: UI elements, forms, buttons, navigation, API calls, state management.",
                tools: {
                    bash: buildBashTool(workingDirectory),
                    glob: buildGlobTool(workingDirectory),
                    grep: buildGrepTool(workingDirectory),
                    read_file: buildReadFileTool(workingDirectory),
                    finish: tool({
                        description: "Report your findings.",
                        inputSchema: resultSchema,
                        execute: async (output) => {
                            result = output;
                        },
                    }),
                },
                stopWhen: [stepCountIs(15), hasToolCall("finish")],
                onStepFinish: () => {
                    onHeartbeat?.();
                },
            });

            try {
                await subagent.generate({
                    messages: [{ role: "user", content: input.instruction }],
                });
                return { findings: result?.findings ?? "Subagent did not produce findings" };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { findings: `Research error: ${message}` };
            }
        },
    });
}
