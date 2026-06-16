import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { HealingAction, HealingReviewLink } from "../../healing/actions";
import type { HealingTestCandidate } from "../../healing/types";
import type { ScenarioIndex } from "../../scenario-index";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioLookupLoop } from "../tools/lookup/scenario-lookup-loop";
import type { TestLookupLoop } from "../tools/lookup/test-lookup-loop";
import type { HealingResult } from "./healing-agent";
import type { HealingNewTest } from "./tools/add-test-tool";

interface HealingAgentLoopParams extends AgentConfig<HealingResult> {
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    scenarioIndex: ScenarioIndex;
    failureKeysByTestCaseId: ReadonlyMap<string, string>;
    failureKeys: ReadonlySet<string>;
    reviewLinksByTestCaseId: ReadonlyMap<string, HealingReviewLink>;
    candidatesById: ReadonlyMap<string, HealingTestCandidate>;
    isFirstTurn: boolean;
}

/**
 * Per-run state for the {@link HealingAgent}. The four per-failure action tools
 * share two invariants the framework enforces inline: each `testCaseId` may
 * only be acted on once per iteration, and every failure key must be addressed
 * before the result tool accepts the finish call. `add_test` is the fifth tool;
 * it targets no failure (so it sits outside the per-failure union) and instead
 * decides candidates - tracked via {@link candidatesById} / {@link
 * claimedCandidateIds}, which the result tool reads to enforce that every
 * candidate is decided. The Loop exposes its state directly so each tool can do
 * its own check + push without a centralised collector.
 */
export class HealingAgentLoop
    extends AgentLoop<HealingResult>
    implements CodebaseLoop, TestLookupLoop, ScenarioLookupLoop
{
    public readonly codebase: Codebase;
    public readonly flowIndex: FlowIndex;
    public readonly existingTests: ExistingTestInfo[];
    public readonly scenarioIndex: ScenarioIndex;

    /** Maps testCaseId → failure key for the failures the agent is asked to handle. */
    public readonly failureKeysByTestCaseId: ReadonlyMap<string, string>;
    /** Every failure key the agent must address before finishing. */
    public readonly failureKeys: ReadonlySet<string>;
    /**
     * Maps each reportable testCaseId to the source review its report action
     * links evidence to. A test case is reportable iff it appears here; the
     * report tools attach the link directly to the action they record. Derived
     * from the failures that carry a review link - failures without source
     * review evidence (and hallucinated IDs) are absent.
     */
    public readonly reviewLinksByTestCaseId: ReadonlyMap<string, HealingReviewLink>;
    /** Candidates offered this turn, by id. Empty on turns with no candidates. */
    public readonly candidatesById: ReadonlyMap<string, HealingTestCandidate>;
    /** Whether this is the first turn of the refinement loop (gates spontaneous add_test). */
    public readonly isFirstTurn: boolean;

    /** Per-failure actions the agent has recorded this iteration. */
    public readonly actions: HealingAction[] = [];
    /** New tests the agent has recorded this iteration via `add_test`. */
    public readonly newTests: HealingNewTest[] = [];
    /** testCaseIds that already have an action recorded - used by tools to reject duplicates. */
    public readonly handledTestCaseIds = new Set<string>();
    /** Failure keys whose test case has been addressed. */
    public readonly handledFailureKeys = new Set<string>();
    /** Candidate ids accepted by an `add_test` call this iteration. */
    public readonly claimedCandidateIds = new Set<string>();

    constructor({
        codebase,
        flowIndex,
        existingTests,
        scenarioIndex,
        failureKeysByTestCaseId,
        failureKeys,
        reviewLinksByTestCaseId,
        candidatesById,
        isFirstTurn,
        ...config
    }: HealingAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.flowIndex = flowIndex;
        this.existingTests = existingTests;
        this.scenarioIndex = scenarioIndex;
        this.failureKeysByTestCaseId = failureKeysByTestCaseId;
        this.failureKeys = failureKeys;
        this.reviewLinksByTestCaseId = reviewLinksByTestCaseId;
        this.candidatesById = candidatesById;
        this.isFirstTurn = isFirstTurn;
    }

    /** Failure keys the agent has yet to address. */
    public unhandledFailureKeys(): string[] {
        return [...this.failureKeys].filter((k) => !this.handledFailureKeys.has(k));
    }

    protected override snapshotPartial(): { actions: HealingAction[]; newTests: HealingNewTest[] } {
        return { actions: [...this.actions], newTests: [...this.newTests] };
    }
}
