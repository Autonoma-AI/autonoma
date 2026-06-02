import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { ScenarioIndex } from "../../scenario-index";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioLookupLoop } from "../tools/lookup/scenario-lookup-loop";
import type { TestLookupLoop } from "../tools/lookup/test-lookup-loop";
import type { ResolutionAgentResult } from "./resolution-agent";
import type { GeneratedTest } from "./tools/add-test-tool";
import type { ModifiedTest } from "./tools/modify-test-tool";
import type { RemovedTest } from "./tools/remove-test-tool";
import type { ReportedBug } from "./tools/report-bug-tool";

interface ResolutionAgentLoopParams extends AgentConfig<ResolutionAgentResult> {
    codebase: Codebase;
    flowIndex: FlowIndex;
    scenarioIndex: ScenarioIndex;
    existingTests: ExistingTestInfo[];
    failedSlugs: ReadonlySet<string>;
    quarantinedSlugs: ReadonlySet<string>;
}

/** The per-failure action kinds that share the "one action per failed slug" invariant. */
export type ResolutionActionKind = "modify_test" | "remove_test" | "report_bug";

/**
 * Per-run state for the {@link ResolutionAgent}. Exposes the codebase, test
 * and scenario indices, the failed/quarantined slug sets, and the four action
 * arrays directly as public fields. Action tools push into the arrays and
 * consult the slug sets; the result tool reads from the arrays.
 *
 * Invariant: each failed slug receives exactly one of `modify_test`,
 * `remove_test`, or `report_bug` per run. {@link handledSlugs} tracks which
 * slugs have already been acted on so per-failure tools can reject duplicates
 * at the boundary. `add_test` does not participate (new tests have no
 * pre-existing slug to clash with).
 */
export class ResolutionAgentLoop
    extends AgentLoop<ResolutionAgentResult>
    implements CodebaseLoop, TestLookupLoop, ScenarioLookupLoop
{
    public readonly codebase: Codebase;
    public readonly flowIndex: FlowIndex;
    public readonly scenarioIndex: ScenarioIndex;
    public readonly existingTests: ExistingTestInfo[];

    /** Failed test slugs the agent must handle this run. */
    public readonly failedSlugs: ReadonlySet<string>;
    /** Slugs quarantined in this snapshot (excluded from replay). */
    public readonly quarantinedSlugs: ReadonlySet<string>;

    public readonly modifiedTests: ModifiedTest[] = [];
    public readonly removedTests: RemovedTest[] = [];
    public readonly reportedBugs: ReportedBug[] = [];
    public readonly newTests: GeneratedTest[] = [];

    /** slug → kind of the per-failure action that already claimed this slug this run. */
    public readonly handledSlugs = new Map<string, ResolutionActionKind>();

    constructor({
        codebase,
        flowIndex,
        scenarioIndex,
        existingTests,
        failedSlugs,
        quarantinedSlugs,
        ...config
    }: ResolutionAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.flowIndex = flowIndex;
        this.scenarioIndex = scenarioIndex;
        this.existingTests = existingTests;
        this.failedSlugs = failedSlugs;
        this.quarantinedSlugs = quarantinedSlugs;
    }

    protected override snapshotPartial(): {
        modifiedTests: ModifiedTest[];
        removedTests: RemovedTest[];
        reportedBugs: ReportedBug[];
        newTests: GeneratedTest[];
    } {
        return {
            modifiedTests: [...this.modifiedTests],
            removedTests: [...this.removedTests],
            reportedBugs: [...this.reportedBugs],
            newTests: [...this.newTests],
        };
    }
}
