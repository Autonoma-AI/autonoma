/**
 * Capability interfaces that {@link AgentLoop} subclasses can implement to expose typed per-run
 * state to shared tools. Tools depend on the narrowest capability they need (e.g. a `BashTool` is
 * `AgentTool<TInput, TOutput, CodebaseLoop>`); concrete loops implement zero or more capabilities
 * based on which tools they wire up.
 */
import type { AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../codebase";
import type { ExistingTestInfo } from "../diffs-agent";
import type { FlowIndex } from "../flow-index";
import type { ReviewStepScreenshots, ScreenshotLoader } from "../review/kernel/review-tools";
import type { ScenarioIndex } from "../scenario-index";

/** Loop that exposes a {@link Codebase} - a handle to the user's repo on disk. */
export interface CodebaseLoop extends AgentLoop {
    readonly codebase: Codebase;
}

/**
 * Loop that knows about the existing test suite: the flow tree and the tests under each flow.
 * Consumed by `list_flows`, `list_tests`, `read_tests`.
 */
export interface TestLookupLoop extends AgentLoop {
    readonly flowIndex: FlowIndex;
    readonly existingTests: ExistingTestInfo[];
}

/**
 * Loop that exposes named test data environments. Consumed by `list_scenarios` and `read_scenario`,
 * and indirectly by `add_test` when grounding a new test's preconditions.
 */
export interface ScenarioLookupLoop extends AgentLoop {
    readonly scenarioIndex: ScenarioIndex;
}

/**
 * Loop that exposes the screenshot evidence for a generation or replay being reviewed. Consumed
 * by `view_step_screenshot` and `view_final_screenshot` in the reviewer agents.
 */
export interface ScreenshotInspectionLoop extends AgentLoop {
    readonly screenshotLoader: ScreenshotLoader;
    readonly steps: ReviewStepScreenshots[];
    readonly finalScreenshotKey?: string;
}
