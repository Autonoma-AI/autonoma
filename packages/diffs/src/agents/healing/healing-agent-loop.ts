import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { HealingAction, HealingReviewLink } from "../../healing/actions";
import type { RenderableReviewStep } from "../../review/kernel";
import type { ScenarioIndex } from "../../scenario-index";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioLookupLoop } from "../tools/lookup/scenario-lookup-loop";
import type { TestLookupLoop } from "../tools/lookup/test-lookup-loop";
import type { ScreenshotLoader } from "../tools/screenshot/screenshot-types";
import type { HealingResult } from "./healing-agent";

interface HealingAgentLoopParams extends AgentConfig<HealingResult> {
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    scenarioIndex: ScenarioIndex;
    failureKeysByTestCaseId: ReadonlyMap<string, string>;
    failureKeys: ReadonlySet<string>;
    reviewLinksByTestCaseId: ReadonlyMap<string, HealingReviewLink>;
    stepEvidenceByFailureKey: ReadonlyMap<string, RenderableReviewStep[]>;
    screenshotLoader?: ScreenshotLoader;
}

/**
 * Per-run state for the {@link HealingAgent}. The four per-failure action tools
 * share two invariants the framework enforces inline: each `testCaseId` may
 * only be acted on once per iteration, and every failure key must be addressed
 * before the result tool accepts the finish call. Healing only heals and culls;
 * it never authors tests, so the loop exposes its action state directly and each
 * tool does its own check + push without a centralised collector.
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

    /**
     * Maps each failure key to the subject's executed steps. `fetch_step_evidence`
     * reads this to know which steps exist and their screenshot keys, then
     * rehydrates the bytes via {@link screenshotLoader} on demand.
     */
    public readonly stepEvidenceByFailureKey: ReadonlyMap<string, RenderableReviewStep[]>;
    /**
     * Rehydrates a step screenshot's bytes from its S3 key at tool-call time.
     * Absent outside production (e.g. evals), where `fetch_step_evidence` degrades
     * to returning step-output text without screenshots.
     */
    public readonly screenshotLoader?: ScreenshotLoader;

    /** Per-failure actions the agent has recorded this iteration. */
    public readonly actions: HealingAction[] = [];
    /** testCaseIds that already have an action recorded - used by tools to reject duplicates. */
    public readonly handledTestCaseIds = new Set<string>();
    /** Failure keys whose test case has been addressed. */
    public readonly handledFailureKeys = new Set<string>();

    constructor({
        codebase,
        flowIndex,
        existingTests,
        scenarioIndex,
        failureKeysByTestCaseId,
        failureKeys,
        reviewLinksByTestCaseId,
        stepEvidenceByFailureKey,
        screenshotLoader,
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
        this.stepEvidenceByFailureKey = stepEvidenceByFailureKey;
        this.screenshotLoader = screenshotLoader;
    }

    /** Failure keys the agent has yet to address. */
    public unhandledFailureKeys(): string[] {
        return [...this.failureKeys].filter((k) => !this.handledFailureKeys.has(k));
    }

    protected override snapshotPartial(): { actions: HealingAction[] } {
        return { actions: [...this.actions] };
    }
}
