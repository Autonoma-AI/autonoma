import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasToolCall, type LanguageModel, stepCountIs, tool, ToolLoopAgent } from "ai";
import matter from "gray-matter";
import { z } from "zod";
import { AI_MAX_RETRIES } from "../../core/model";
import { buildBashTool, buildGlobTool, buildGrepTool, buildReadFileTool } from "../../tools";
import { type CoverageState, saveBfsState } from "./graph";
import { VALID_VERBS } from "./validation";

const testFrontmatterSchema = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    intent: z
        .string()
        .min(30, "Intent must be at least 30 characters - describe the BEHAVIOR being tested, not the steps"),
    criticality: z.enum(["critical", "high", "mid", "low"]),
    scenario: z.string().min(1),
    flow: z.string().min(1),
    verification: z
        .string()
        .min(
            20,
            "Verification must describe WHERE to navigate and WHAT to assert at the source of truth - not UI acknowledgments like toasts",
        ),
});

/**
 * Test steps must use exact, concrete values from the scenario - no
 * placeholders, tokens, or examples. Scenario data is fully static (the planner
 * has no variable mechanism), so any `{{token}}`, bare `{variable}`, "Dynamic:",
 * or "e.g." in the steps is a value the visual agent cannot resolve. Returns the
 * first offending placeholder found, or null when the steps are clean.
 */
export function findForbiddenPlaceholder(stepsSection: string): { name: string; match: string } | undefined {
    const placeholderPatterns = [
        { pattern: /Dynamic:\s/gi, name: '"Dynamic:" placeholder' },
        { pattern: /\{\{[a-zA-Z0-9_]+\}\}/g, name: "{{token}} placeholder" },
        { pattern: /(?<!\{)\{[a-z][a-zA-Z]*\}(?!\})/g, name: "bare {variable}" },
        { pattern: /\(e\.g\./gi, name: '"(e.g." example' },
        { pattern: /(?:^|\s)e\.g\.,?\s/gim, name: '"e.g." example' },
    ];

    for (const { pattern, name } of placeholderPatterns) {
        const matches = stepsSection.match(pattern);
        if (matches && matches.length > 0) {
            return { name, match: matches[0] };
        }
    }

    return undefined;
}

export function buildWriteTestTool(state: CoverageState, outputDir: string) {
    return tool({
        description:
            "Write a test file to qa-tests/{folder}/{filename}.md. " +
            "Validates frontmatter before writing. Returns error if frontmatter is invalid.",
        inputSchema: z.object({
            folder: z.string().describe("Subfolder name under qa-tests/"),
            filename: z.string().describe("File name (e.g. login-valid-credentials.md)"),
            content: z.string().describe("Full file content including YAML frontmatter"),
            nodeId: z.string().describe("The FeatureNode ID this test belongs to"),
        }),
        execute: async (input) => {
            const frontmatter = extractFrontmatter(input.content);
            if (!frontmatter) {
                return { error: "File must start with YAML frontmatter (--- delimiters)" };
            }

            const parsed = testFrontmatterSchema.safeParse(frontmatter);
            if (!parsed.success) {
                return {
                    error: `Invalid frontmatter: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
                };
            }

            if (!/\*\*Intent\*\*:/.test(input.content)) {
                return {
                    error: "Test must include an **Intent**: section between Setup and Steps describing what behavior is being tested",
                };
            }

            const allSteps = input.content.match(/^\d+\.\s+(\w+):/gm) || [];
            for (const step of allSteps) {
                const verbMatch = step.match(/^\d+\.\s+(\w+):/);
                if (verbMatch && !VALID_VERBS.has(verbMatch[1]!)) {
                    return {
                        error: `Invalid step verb "${verbMatch[1]}". Only valid verbs are: ${[...VALID_VERBS].join(", ")}`,
                    };
                }
            }

            const stepMatches =
                input.content.match(/^\d+\.\s+(click|type|scroll|assert|hover|drag|read|refresh):/gm) || [];
            const interactions = stepMatches.filter((s) => /^\d+\.\s+(click|type|drag):/.test(s));
            if (interactions.length < 2) {
                return {
                    error:
                        `Test has ${interactions.length} interaction(s) (click/type/drag). Minimum is 2. ` +
                        `Visibility-only tests are not allowed - what BEHAVIOR does this test verify?`,
                };
            }

            const bodyStart = input.content.indexOf("---", 3);
            const body = bodyStart > -1 ? input.content.slice(bodyStart + 3) : input.content;
            const stepsSection = body.slice(body.indexOf("**Steps**") || 0);

            const placeholder = findForbiddenPlaceholder(stepsSection);
            if (placeholder) {
                return {
                    error:
                        `Test steps contain ${placeholder.name}: "${placeholder.match}". ` +
                        `Use EXACT values from scenarios.md - not placeholders or examples.`,
                };
            }

            const relPath = join("qa-tests", input.folder, input.filename);
            const absPath = join(outputDir, relPath);

            try {
                await mkdir(dirname(absPath), { recursive: true });
                await writeFile(absPath, input.content, "utf-8");
                state.markTested(input.nodeId, [relPath]);
                await saveBfsState(outputDir, state);
                return { path: relPath, title: parsed.data.title };
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
            const absPath = join(outputDir, "qa-tests", input.folder);
            try {
                await mkdir(absPath, { recursive: true });
                return { path: join("qa-tests", input.folder) };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { error: `Failed to create folder: ${message}` };
            }
        },
    });
}

export function buildNextNodeTool(state: CoverageState, outputDir: string) {
    return tool({
        description:
            "Get the next node to write tests for. If you called next_node before " +
            "without writing any tests (via write_test), the previous node is auto-skipped. " +
            "Returns done:true when all nodes are processed.",
        inputSchema: z.object({}),
        execute: async () => {
            const next = state.nextNode();
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
                },
                remaining: next.remaining,
                instruction: `Explore "${next.node.name}": read its source files, find all interactive elements, then write tests with write_test. If no tests are needed after reading the source (e.g. utility route, redirect), call next_node to skip.`,
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

function extractFrontmatter(content: string): Record<string, unknown> | undefined {
    try {
        const { data } = matter(content);
        return data && Object.keys(data).length > 0 ? data : undefined;
    } catch {
        return undefined;
    }
}
