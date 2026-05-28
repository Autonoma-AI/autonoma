import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { HealingAction } from "../../healing/actions";
import type { ScenarioIndex } from "../../scenario-index";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioLookupLoop } from "../tools/lookup/scenario-lookup-loop";
import type { HealingResult } from "./healing-agent";

interface HealingAgentLoopParams extends AgentConfig<HealingResult> {
    codebase: Codebase;
    scenarioIndex: ScenarioIndex;
    failureKeysByTestCaseId: ReadonlyMap<string, string>;
    failureKeys: ReadonlySet<string>;
    reportableTestCaseIds: ReadonlySet<string>;
}

/**
 * Per-run state for the {@link HealingAgent}. The four action tools share two
 * invariants that the framework enforces inline: each `testCaseId` may only
 * be acted on once per iteration, and every failure key must be addressed
 * before the result tool accepts the finish call. The Loop exposes
 * {@link actions}, {@link handledTestCaseIds}, {@link handledFailureKeys},
 * and {@link failureKeysByTestCaseId} directly so each action tool can do its
 * own check + push without going through a centralised collector.
 */
export class HealingAgentLoop extends AgentLoop<HealingResult> implements CodebaseLoop, ScenarioLookupLoop {
    public readonly codebase: Codebase;
    public readonly scenarioIndex: ScenarioIndex;

    /** Maps testCaseId → failure key for the failures the agent is asked to handle. */
    public readonly failureKeysByTestCaseId: ReadonlyMap<string, string>;
    /** Every failure key the agent must address before finishing. */
    public readonly failureKeys: ReadonlySet<string>;
    /**
     * testCaseIds that may be targeted by report_bug / report_engine_limitation.
     * Excludes hallucinated IDs and failures without source review evidence.
     */
    public readonly reportableTestCaseIds: ReadonlySet<string>;

    /** Actions the agent has recorded this iteration. */
    public readonly actions: HealingAction[] = [];
    /** testCaseIds that already have an action recorded - used by tools to reject duplicates. */
    public readonly handledTestCaseIds = new Set<string>();
    /** Failure keys whose test case has been addressed. */
    public readonly handledFailureKeys = new Set<string>();

    constructor({
        codebase,
        scenarioIndex,
        failureKeysByTestCaseId,
        failureKeys,
        reportableTestCaseIds,
        ...config
    }: HealingAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.scenarioIndex = scenarioIndex;
        this.failureKeysByTestCaseId = failureKeysByTestCaseId;
        this.failureKeys = failureKeys;
        this.reportableTestCaseIds = reportableTestCaseIds;
    }

    /** Failure keys the agent has yet to address. */
    public unhandledFailureKeys(): string[] {
        return [...this.failureKeys].filter((k) => !this.handledFailureKeys.has(k));
    }

    protected override snapshotPartial(): { actions: HealingAction[] } {
        return { actions: [...this.actions] };
    }
}
