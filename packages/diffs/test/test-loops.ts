import { FinishTool } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import { z } from "zod";
import type { DiffsAgentResult } from "../src/agents/diffs/diffs-agent";
import { DiffsAgentLoop } from "../src/agents/diffs/diffs-agent-loop";
import { HealingAgentLoop } from "../src/agents/healing/healing-agent-loop";
import { ReviewerLoop } from "../src/agents/reviewers/reviewer-loop";
import type { ReviewStepScreenshots, ScreenshotLoader } from "../src/agents/tools/screenshot/screenshot-types";
import { Codebase } from "../src/codebase";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import type { HealingReviewLink } from "../src/healing/actions";
import type { ScenarioData } from "../src/scenario-data";
import { ScenarioIndex } from "../src/scenario-index";
import type { ScenarioRecipeData } from "../src/scenario-recipe";

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

export interface ReviewerLoopOverrides {
    workingDirectory?: string;
    scenarioData?: ScenarioData;
    steps?: ReviewStepScreenshots[];
    screenshotLoader?: ScreenshotLoader;
    architecture?: ApplicationArchitecture;
}

export function makeReviewerLoop(overrides: ReviewerLoopOverrides = {}): ReviewerLoop<never> {
    return new ReviewerLoop<never>({
        name: "ReviewerTest",
        model: FAKE_MODEL,
        systemPrompt: "",
        tools: [],
        reportTool: FAKE_RESULT_TOOL as never,
        codebase: new Codebase(overrides.workingDirectory ?? process.cwd()),
        screenshotLoader: overrides.screenshotLoader ?? { loadScreenshot: async () => Buffer.alloc(0) },
        steps: overrides.steps ?? [],
        scenarioData: overrides.scenarioData,
        architecture: overrides.architecture,
    });
}

export interface HealingLoopOverrides {
    workingDirectory?: string;
    flowIndex?: FlowIndex;
    scenarioIndex?: ScenarioIndex;
    existingTests?: ExistingTestInfo[];
    failureKeysByTestCaseId?: ReadonlyMap<string, string>;
    failureKeys?: ReadonlySet<string>;
    reviewLinksByTestCaseId?: ReadonlyMap<string, HealingReviewLink>;
}

export function makeHealingLoop(overrides: HealingLoopOverrides = {}): HealingAgentLoop {
    const existingTests = overrides.existingTests ?? [];
    return new HealingAgentLoop({
        name: "HealingAgentTest",
        model: FAKE_MODEL,
        systemPrompt: "",
        tools: [],
        reportTool: FAKE_RESULT_TOOL as never,
        codebase: new Codebase(overrides.workingDirectory ?? process.cwd()),
        flowIndex:
            overrides.flowIndex ??
            new FlowIndex([{ id: "all", name: "All Tests", testSlugs: existingTests.map((t) => t.slug) }]),
        scenarioIndex: overrides.scenarioIndex ?? new ScenarioIndex([]),
        existingTests,
        failureKeysByTestCaseId: overrides.failureKeysByTestCaseId ?? new Map(),
        failureKeys: overrides.failureKeys ?? new Set(),
        reviewLinksByTestCaseId: overrides.reviewLinksByTestCaseId ?? new Map(),
    });
}
