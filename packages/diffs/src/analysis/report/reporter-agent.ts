import { Agent, type LanguageModel, type ModelMessage } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { sharedCompactor } from "../../agents/compaction";
import { buildCodebaseTools } from "../../agents/tools/codebase/build-codebase-tools";
import { buildRepoManifestSection } from "../../codebase";
import { REPORTER_SYSTEM_PROMPT, buildReporterPrompt } from "./prompt";
import { ReporterAgentLoop } from "./reporter-agent-loop";
import { ReporterResultTool } from "./reporter-result-tool";
import { CarryForwardIssueTool } from "./tools/carry-forward-issue-tool";
import { FetchEvidenceTool } from "./tools/fetch-evidence-tool";
import { OpenIssueTool } from "./tools/open-issue-tool";
import { ReadScenarioTool } from "./tools/read-scenario-tool";
import { ResolveIssueTool } from "./tools/resolve-issue-tool";
import type { ReporterInput, ReporterResult } from "./types";

export interface ReporterAgentConfig {
    model: LanguageModel;
}

/**
 * Reconciles a job's findings into de-duped, branch-scoped issues, clusters the branch's last-known verdict per test
 * into reader-facing flows, and authors how the PR reads: its title, its headline, and one holistic report. Runs on
 * the AgentLoop harness - a per-run loop holds the minted-evidence allow-list, and the terminal tool enforces the
 * coverage guarantees, derives every flow's status and owner, and grounds every authored surface before returning.
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
                runKind: input.target.kind,
                findings: input.findings.length,
                branchTests: input.branchTests.length,
                existingIssues: input.existingIssues.length,
            },
        });
        const messages = buildReporterPrompt(input);

        // When the snapshot deployed a multi-repo preview, tell the reporter which dependency repos are checked
        // out beside the primary, so it can re-ground a suspectedCause in a dependency and set its `repo`.
        const manifest = input.codebase.dependencyManifest();
        if (manifest == null) return messages;
        return [
            ...messages,
            { role: "user", content: `## Repositories\n\n${await buildRepoManifestSection(manifest)}` },
        ];
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
            compactor: sharedCompactor(),
            codebase: input.codebase,
            screenshotLoader: input.screenshotLoader,
            scenarioLoader: input.scenarioLoader,
            findings: input.findings,
            branchTests: input.branchTests,
            existingIssues: input.existingIssues,
            scenarioIndex: input.scenarioIndex,
        });
    }
}
