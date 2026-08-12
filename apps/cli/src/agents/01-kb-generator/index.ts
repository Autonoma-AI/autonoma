import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type LanguageModel, tool } from "ai";
import { z } from "zod";
import { type AgentResult, buildDefaultStepLogger, formatRetryGuidance, runAgent } from "../../core/agent";
import { debugLog } from "../../core/debug";
import { resolveModel } from "../../core/model";
import { pickString } from "../../core/pick-string";
import { reportSubProgress } from "../../core/progress";
import type { buildReadFileTool } from "../../tools";
import { buildCodebaseTools } from "../../tools";
import { CoreFlowsSpec } from "./flow-spec";
import { SYSTEM_PROMPT } from "./prompt";
import { collectRepoSignals, renderRepoSignals } from "./repo-signals";
import { stabilizeFlowIds } from "./stabilize-flow-ids";

const FLOWS_FILE = "flows.json";

/**
 * The flow ranking from a previous KB run, or nothing when the step has not run
 * or wrote something malformed. Callers fall back to unranked behaviour rather
 * than failing: a missing ranking should cost budget precision, not the run.
 */
export async function loadFlows(outputDir: string): Promise<CoreFlowsSpec | undefined> {
    try {
        const raw = await readFile(join(outputDir, FLOWS_FILE), "utf-8");
        const parsed = CoreFlowsSpec.safeParse(JSON.parse(raw));
        if (!parsed.success) {
            console.warn(`  ${FLOWS_FILE} does not match the expected shape; ignoring the flow ranking`);
            debugLog("flows.json failed validation", { issues: parsed.error.issues });
            return undefined;
        }
        return parsed.data;
    } catch (err) {
        debugLog("No flows.json to load", { outputDir, err });
        return undefined;
    }
}

export interface KBGeneratorInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    /**
     * An already-built model, used in place of `modelId`. The product never passes
     * this; the evals do, so the step can be driven against a provider directly
     * rather than through the authenticated proxy `getModel` requires.
     */
    model?: LanguageModel;
    nonInteractive?: boolean;
    retryGuidance?: string;
    /** Evals only: drop the git-history evidence, to measure what it changes. */
    skipRepoSignals?: boolean;
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

/**
 * Take the flow ranking as a validated payload rather than as YAML the agent
 * hand-writes into frontmatter. The prose version parsed back defensively -
 * coercing every field and silently yielding an empty list when it did not match
 * - so a malformed ranking looked identical to a product with no flows.
 */
function buildSubmitCoreFlowsTool(onFlows: (spec: CoreFlowsSpec) => void) {
    return tool({
        description:
            "Submit the product pitch and the complete ranked flow list. Call once, before finish. " +
            "Every page you registered must be reachable through some flow's entryPoints.",
        inputSchema: CoreFlowsSpec,
        execute: (spec: CoreFlowsSpec) => {
            onFlows(spec);
            const byTier = spec.flows.reduce<Record<number, number>>((acc, f) => {
                acc[f.tier] = (acc[f.tier] ?? 0) + 1;
                return acc;
            }, {});
            return `Recorded ${spec.flows.length} flows (tier 1: ${byTier[1] ?? 0}, tier 2: ${byTier[2] ?? 0}, tier 3: ${byTier[3] ?? 0}).`;
        },
    });
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
    model: LanguageModel,
    input: KBGeneratorInput,
    onStepFinish: ReturnType<typeof buildDefaultStepLogger>["onStepFinish"],
    setResult: (r: AgentResult) => void,
    setFlows: (spec: CoreFlowsSpec) => void,
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
                submit_core_flows: buildSubmitCoreFlowsTool(setFlows),
                finish: buildFinishTool(tracker, setResult),
            };
        },
        onStepFinish,
    };
}

export async function runKBGenerator(input: KBGeneratorInput): Promise<AgentResult> {
    const model = resolveModel(input);

    let result: AgentResult | undefined;
    const setResult = (r: AgentResult) => {
        result = r;
    };

    let flows: CoreFlowsSpec | undefined;
    // Canonicalise the model-invented flow ids to stable, route-derived ones before
    // anything downstream reads them: flows.json, the budget ledger and the closed-set
    // enforcement all key on this id, and the model reinvents it every run.
    const setFlows = (spec: CoreFlowsSpec) => {
        flows = stabilizeFlowIds(spec);
    };

    const { logger, onStepFinish } = buildDefaultStepLogger("kb", 150);

    const contextBlock = formatRetryGuidance(input.retryGuidance);

    const tracker = new PageTracker(input.projectRoot);

    const basePrompt = `Analyze the codebase at the working directory and generate a complete knowledge base.
${contextBlock}
MANDATORY PROCESS:
1. Use list_directory at root to understand the project structure
2. Use glob to find ALL page/route files, however this project's framework names them (discover the convention from the structure - do not assume one)
3. Call register_pages with the FULL list of page files from glob
4. Read EVERY registered page file with read_file - the system tracks this
5. Write AUTONOMA.md progressively as you go (update it after each major area)
6. Call page_coverage to verify you've read all pages
7. Call finish - it will REJECT if you have not read enough of the registered routes

Output files:
1. AUTONOMA.md - with YAML frontmatter (app_name, app_description, core_flows, feature_count)`;

    // History is evidence for riskDrivers, never for tier: where a team spends its
    // time says how hard a surface is to get right, not whether the product is
    // sold on it. Absent (shallow clone, no git) the step runs unchanged.
    const signals = input.skipRepoSignals === true ? undefined : await collectRepoSignals(input.projectRoot);
    const prompt = signals != null ? `${basePrompt}\n${renderRepoSignals(signals)}` : basePrompt;
    if (signals != null) {
        console.log(`  Read ${signals.totalCommits} commits of history for risk signals`);
    }

    const agentConfig = buildKbAgentConfig(tracker, model, input, onStepFinish, setResult, setFlows);
    await runAgent(agentConfig, prompt, () => result);
    logger.summary();

    // Written separately from AUTONOMA.md so the ranking survives as data. The
    // markdown is for a human to read; every later step budgets against this.
    if (flows != null) {
        await writeFile(join(input.outputDir, FLOWS_FILE), JSON.stringify(flows, null, 2), "utf-8");
        console.log(`  Pitch: ${flows.pitch}`);
    } else {
        console.warn("  No flow ranking submitted; later steps fall back to per-page budget");
    }

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
        // Say how much of the app this KB was actually built from. The fallback
        // exists so a blocked finish does not throw away real work, but a run that
        // read a fraction of the routes produces a knowledge base - and a flow
        // ranking - describing an app nobody looked at, and every later step
        // budgets against it. Reporting that as a plain success hides the one fact
        // that explains a bad suite.
        const cov = tracker.coverage();
        const pct = cov.total > 0 ? Math.round((cov.read / cov.total) * 100) : 100;
        if (cov.read < requiredReads(cov.total)) {
            console.warn(
                `  Knowledge base built from ${cov.read}/${cov.total} routes (${pct}%) - below the coverage gate. ` +
                    `Flow tiers derived from it are unreliable.`,
            );
        }
        result = {
            success: true,
            artifacts: ["AUTONOMA.md"],
            summary: `Knowledge base generated from ${cov.read}/${cov.total} routes (${pct}%).`,
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
