import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { type AgentResult, buildDefaultStepLogger, formatRetryGuidance, runAgent } from "../../core/agent";
import { debugLog } from "../../core/debug";
import { getModel } from "../../core/model";
import { pickString } from "../../core/pick-string";
import { reportSubProgress } from "../../core/progress";
import type { buildReadFileTool } from "../../tools";
import { buildCodebaseTools } from "../../tools";
import { SYSTEM_PROMPT } from "./prompt";

export interface KBGeneratorInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    nonInteractive?: boolean;
    retryGuidance?: string;
}

class PageTracker {
    registered = new Set<string>();
    read = new Set<string>();

    // Registered pages (from pages.json) are absolute paths, but the agent reads them
    // with paths relative to the working directory. Canonicalize both to an absolute
    // path against projectRoot so coverage matches regardless of how each side spelled
    // it - otherwise the finish gate never clears and the agent nudges out re-reading.
    constructor(private readonly projectRoot: string) {}

    private normalize(filePath: string): string {
        return resolve(this.projectRoot, filePath);
    }

    register(pages: string[]) {
        for (const p of pages) this.registered.add(this.normalize(p));
        reportSubProgress("kb", this.read.size, this.registered.size, "pages");
    }

    markRead(filePath: string) {
        const normalized = this.normalize(filePath);
        if (this.registered.has(normalized)) {
            this.read.add(normalized);
            reportSubProgress("kb", this.read.size, this.registered.size, "pages");
        }
    }

    unread(): string[] {
        return [...this.registered].filter((p) => !this.read.has(p));
    }

    coverage(): { total: number; read: number; unread: string[] } {
        return {
            total: this.registered.size,
            read: this.read.size,
            unread: this.unread(),
        };
    }
}

function buildRegisterPagesTool(tracker: PageTracker) {
    return tool({
        description:
            "Register ALL page/route files discovered via glob. " +
            "Call this ONCE after globbing for page files. " +
            "The system will track which ones you've read and block finish until all are covered.",
        inputSchema: z.object({
            pages: z.array(z.string()).describe("All page file paths found by glob"),
        }),
        execute: async (input) => {
            tracker.register(input.pages);
            return {
                registered: input.pages.length,
                message: `Registered ${input.pages.length} pages. You must read_file each one before calling finish.`,
            };
        },
    });
}

function buildPageCoverageTool(tracker: PageTracker) {
    return tool({
        description: "Check how many registered pages you've read vs how many remain.",
        inputSchema: z.object({}),
        execute: async () => tracker.coverage(),
    });
}

// "Small" vs "large" app is decided purely by how many routes were registered - the one
// number that drives the coverage problem. At or below this many routes the agent can
// (and must) read every one, so the finish gate demands 100%. Above it, a single pass
// samples the app rather than reading all routes, and an unreachable 100% gate makes the
// agent nudge-thrash; there we let it finish once it has covered a solid floor instead.
const FULL_COVERAGE_MAX_ROUTES = 40;
const LARGE_APP_COVERAGE_FLOOR = 0.5;

/** How many registered routes must be read before finish is allowed, given the total. */
function requiredReads(total: number): number {
    if (total <= FULL_COVERAGE_MAX_ROUTES) return total;
    return Math.ceil(total * LARGE_APP_COVERAGE_FLOOR);
}

function buildFinishTool(tracker: PageTracker, onFinish: (result: AgentResult) => void) {
    return tool({
        description:
            "Call when you have finished generating the knowledge base. " +
            "BLOCKED until you have read enough of the registered routes (every route on a small app; a strong " +
            "majority on a large one) - call page_coverage first to check how many remain.",
        inputSchema: z.object({
            summary: z.string().describe("Summary of what was generated"),
            artifacts: z.array(z.string()).describe("List of files written"),
        }),
        execute: async (input) => {
            const cov = tracker.coverage();
            const required = requiredReads(cov.total);
            if (cov.read < required) {
                const preview = cov.unread.slice(0, 40).join("\n");
                const more = cov.unread.length > 40 ? `\n...and ${cov.unread.length - 40} more` : "";
                return {
                    error:
                        `Cannot finish: only ${cov.read}/${cov.total} routes read - read at least ${required - cov.read} ` +
                        `more (target ${required} of ${cov.total}). Start with:\n${preview}${more}`,
                };
            }
            onFinish({
                success: true,
                artifacts: input.artifacts,
                summary: input.summary,
            });
            return { success: true };
        },
    });
}

function buildTrackedReadTool(tracker: PageTracker, baseTool: ReturnType<typeof buildReadFileTool>) {
    return tool({
        description: baseTool.description,
        inputSchema: baseTool.inputSchema,
        execute: async (input, options) => {
            const filePath = pickString(input, ["filePath", "path", "file_path"]) ?? "";
            tracker.markRead(filePath);
            return baseTool.execute!(input, options);
        },
    });
}

/**
 * The KB agent config, parameterized by the page tracker so the main generation pass and
 * the finalization passes each get their own coverage gate. Keeping this in one place
 * means the tuned SYSTEM_PROMPT and tool wiring stay identical across every pass.
 */
function buildKbAgentConfig(
    tracker: PageTracker,
    model: ReturnType<typeof getModel>,
    input: KBGeneratorInput,
    onStepFinish: ReturnType<typeof buildDefaultStepLogger>["onStepFinish"],
    setResult: (r: AgentResult) => void,
) {
    return {
        id: "kb-generator",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: 150,
        tools: async (heartbeat: () => void) => {
            const onFileRead = (path: string) => tracker.markRead(path);
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat, onFileRead);
            return {
                ...tools,
                read_file: buildTrackedReadTool(tracker, tools.read_file),
                register_pages: buildRegisterPagesTool(tracker),
                page_coverage: buildPageCoverageTool(tracker),
                finish: buildFinishTool(tracker, setResult),
            };
        },
        onStepFinish,
    };
}

export async function runKBGenerator(input: KBGeneratorInput): Promise<AgentResult> {
    const model = getModel(input.modelId);

    let result: AgentResult | undefined;
    const setResult = (r: AgentResult) => {
        result = r;
    };

    const { logger, onStepFinish } = buildDefaultStepLogger("kb", 150);

    const contextBlock = formatRetryGuidance(input.retryGuidance);

    const tracker = new PageTracker(input.projectRoot);

    const prompt = `Analyze the codebase at the working directory and generate a complete knowledge base.
${contextBlock}
MANDATORY PROCESS:
1. Use list_directory at root to understand the project structure
2. Use glob to find ALL page/route files (e.g. '**/page.tsx', '**/page.ts')
3. Call register_pages with the FULL list of page files from glob
4. Read EVERY registered page file with read_file - the system tracks this
5. Write AUTONOMA.md progressively as you go (update it after each major area)
6. Call page_coverage to verify you've read all pages
7. Call finish - it will REJECT if you have not read enough of the registered routes

Output files:
1. AUTONOMA.md - with YAML frontmatter (app_name, app_description, core_flows, feature_count)`;

    const agentConfig = buildKbAgentConfig(tracker, model, input, onStepFinish, setResult);
    await runAgent(agentConfig, prompt, () => result);
    logger.summary();

    // The finish tool can be blocked (e.g. by the page-coverage gate) even though
    // the agent already wrote AUTONOMA.md - which would leave `result` undefined
    // and silently skip the whole review. Don't let that happen: if the file
    // exists, treat the step as done so the user still gets the flows table, the
    // file path, and the editor/chat review below.
    const autonomaPath = join(input.outputDir, "AUTONOMA.md");
    const autonomaExists = await readFile(autonomaPath, "utf-8")
        .then(() => true)
        .catch((err) => {
            debugLog("AUTONOMA.md not found while checking step completion", { err });
            return false;
        });
    if (!result?.success && autonomaExists) {
        result = {
            success: true,
            artifacts: ["AUTONOMA.md"],
            summary: "Knowledge base generated.",
        };
    }

    // Output review happens live in the TUI - the run no longer stops to ask.
    const reviewed = result;

    return (
        reviewed ?? {
            success: false,
            artifacts: [],
            summary: "KB generator agent stopped without producing AUTONOMA.md",
        }
    );
}
