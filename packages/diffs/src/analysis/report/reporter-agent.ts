import { Agent, type LanguageModel, RedactOldToolResults } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import { buildCodebaseTools } from "../../agents/tools/codebase/build-codebase-tools";
import { REPORTER_SYSTEM_PROMPT, buildReporterPrompt } from "./prompt";
import { ReporterAgentLoop } from "./reporter-agent-loop";
import { ReporterResultTool } from "./reporter-result-tool";
import { CarryForwardIssueTool } from "./tools/carry-forward-issue-tool";
import { FetchEvidenceTool } from "./tools/fetch-evidence-tool";
import { OpenIssueTool } from "./tools/open-issue-tool";
import { ReadScenarioTool } from "./tools/read-scenario-tool";
import { ResolveIssueTool } from "./tools/resolve-issue-tool";
import type { ReporterInput, ReporterResult } from "./types";

/**
 * Token budget for the previous step's input before compaction trims. Sized like the healing agent to leave
 * headroom for the next step on top of a vision-heavy history.
 */
const COMPACTION_TOKEN_THRESHOLD = 700_000;
/** Number of most recent tool round-trips to keep in full when compaction fires. */
const COMPACTION_KEEP_RECENT_TOOL_RESULTS = 2;

export interface ReporterAgentConfig {
    model: LanguageModel;
}

/**
 * Reconciles a job's findings into de-duped, branch-scoped issues and authors one holistic PR report, on the
 * AgentLoop harness. Unlike the classifier (which bypasses this harness), the Reporter uses it correctly:
 * a per-run loop holds the minted-evidence allow-list, and the terminal tool enforces the coverage guarantees and
 * grounds every authored surface before the result is returned.
 */
export class ReporterAgent extends Agent<ReporterInput, ReporterResult, ReporterAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;

    private readonly codebaseTools = buildCodebaseTools();
    private readonly fetchEvidenceTool = new FetchEvidenceTool();
    private readonly readScenarioTool = new ReadScenarioTool();
    private readonly openIssueTool = new OpenIssueTool();
    private readonly carryForwardIssueTool = new CarryForwardIssueTool();
    private readonly resolveIssueTool = new ResolveIssueTool();
    private readonly resultTool = new ReporterResultTool();

    constructor({ model }: ReporterAgentConfig) {
        super();
        this.model = model;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    protected async buildUserPrompt(input: ReporterInput): Promise<ModelMessage[]> {
        this.logger.info("Building reporter prompt", {
            extra: {
                appSlug: input.appSlug,
                prNumber: input.pr.number,
                findings: input.findings.length,
                existingIssues: input.existingIssues.length,
            },
        });
        return buildReporterPrompt(input);
    }

    protected async createLoop(input: ReporterInput): Promise<ReporterAgentLoop> {
        // Only advertise a tool when it has something to act on: fetch_evidence when some finding carries a
        // screenshot, read_scenario when there is both an index and a loader. Offering a dead tool wastes turns.
        const hasScreenshots = input.findings.some((f) => f.screenshots.length > 0);
        const evidenceTools = hasScreenshots ? [this.fetchEvidenceTool] : [];
        const scenarioTools =
            input.scenarioIndex.length > 0 && input.scenarioLoader != null ? [this.readScenarioTool] : [];

        return new ReporterAgentLoop({
            name: "ReporterAgent",
            model: this.model,
            systemPrompt: REPORTER_SYSTEM_PROMPT,
            tools: [
                ...this.codebaseTools,
                ...evidenceTools,
                ...scenarioTools,
                this.openIssueTool,
                this.carryForwardIssueTool,
                this.resolveIssueTool,
            ],
            reportTool: this.resultTool,
            compactor: {
                strategy: new RedactOldToolResults(COMPACTION_KEEP_RECENT_TOOL_RESULTS),
                threshold: COMPACTION_TOKEN_THRESHOLD,
            },
            codebase: input.codebase,
            screenshotLoader: input.screenshotLoader,
            scenarioLoader: input.scenarioLoader,
            findings: input.findings,
            existingIssues: input.existingIssues,
            scenarioIndex: input.scenarioIndex,
        });
    }
}
