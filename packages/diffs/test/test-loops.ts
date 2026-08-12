import { AgentLoop, type AgentConfig, FinishTool } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import { z } from "zod";
import type { DiffsAgentResult } from "../src/agents/diffs/diffs-agent";
import { DiffsAgentLoop } from "../src/agents/diffs/diffs-agent-loop";
import type { InspectableStep, ScreenshotLoader } from "../src/agents/tools/run-evidence/run-evidence-types";
import type { StepInspectionLoop } from "../src/agents/tools/run-evidence/step-inspection-loop";
import { Codebase } from "../src/codebase";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { ScenarioIndex } from "../src/scenario-index";
import type { ScenarioRecipeData } from "../src/scenario-recipe";
import { whiteScreenshot } from "./screenshot-fixture";

/**
 * Tests bypass the LanguageModel + system-prompt plumbing entirely: they
 * construct a Loop, call a tool's `toTool(loop).execute` directly, and assert
 * on what the wrapped envelope returns. These factories produce loops with
 * the minimum scaffolding needed to satisfy the constructor while letting
 * each test override the parts it cares about.
 */
const FAKE_MODEL = "fake-model" as never;
const FAKE_RESULT_TOOL = new FinishTool<never>({ resultSchema: z.never() });

export interface DiffsLoopOverrides {
    workingDirectory?: string;
    flowIndex?: FlowIndex;
    scenarioIndex?: ScenarioIndex;
    existingTests?: ExistingTestInfo[];
    seededAffected?: DiffsAgentResult["affectedTests"];
    validSlugs?: ReadonlySet<string>;
    validConflictSlugs?: ReadonlySet<string>;
    scenarioRecipes?: ScenarioRecipeData[];
}

export function makeDiffsLoop(overrides: DiffsLoopOverrides = {}): DiffsAgentLoop {
    const existingTests = overrides.existingTests ?? [];
    const flowIndex =
        overrides.flowIndex ??
        new FlowIndex([{ id: "all", name: "All Tests", testSlugs: existingTests.map((t) => t.slug) }]);
    return new DiffsAgentLoop({
        name: "DiffsAgentTest",
        model: FAKE_MODEL,
        systemPrompt: "",
        tools: [],
        reportTool: FAKE_RESULT_TOOL as never,
        codebase: new Codebase(overrides.workingDirectory ?? process.cwd()),
        flowIndex,
        existingTests,
        scenarioIndex: overrides.scenarioIndex ?? new ScenarioIndex([]),
        seededAffected: overrides.seededAffected ?? [],
        validSlugs: overrides.validSlugs ?? new Set(existingTests.map((t) => t.slug)),
        validConflictSlugs: overrides.validConflictSlugs ?? new Set(),
        scenarioRecipes: overrides.scenarioRecipes ?? [],
    });
}

export interface StepInspectionLoopOverrides {
    steps?: InspectableStep[];
    screenshotLoader?: ScreenshotLoader;
    architecture?: ApplicationArchitecture;
}

/**
 * A loop carrying only what {@link StepInspectionLoop} declares - the surface `view_step_details` reads. The
 * live host is `ClassifierAgentLoop`, whose own state (a whole `RunArtifacts`) the tool never touches, so
 * constructing one here would assert nothing the tool depends on.
 */
interface TestStepInspectionLoopParams extends AgentConfig<never> {
    screenshotLoader: ScreenshotLoader;
    steps: InspectableStep[];
    architecture?: ApplicationArchitecture;
}

class TestStepInspectionLoop extends AgentLoop<never> implements StepInspectionLoop {
    public readonly screenshotLoader: ScreenshotLoader;
    public readonly steps: InspectableStep[];
    public readonly architecture?: ApplicationArchitecture;

    constructor({ screenshotLoader, steps, architecture, ...config }: TestStepInspectionLoopParams) {
        super(config);
        this.screenshotLoader = screenshotLoader;
        this.steps = steps;
        this.architecture = architecture;
    }
}

export function makeStepInspectionLoop(overrides: StepInspectionLoopOverrides = {}): StepInspectionLoop {
    return new TestStepInspectionLoop({
        name: "StepInspectionTest",
        model: FAKE_MODEL,
        systemPrompt: "",
        tools: [],
        reportTool: FAKE_RESULT_TOOL as never,
        screenshotLoader: overrides.screenshotLoader ?? { loadScreenshot: () => whiteScreenshot() },
        steps: overrides.steps ?? [],
        architecture: overrides.architecture,
    });
}
