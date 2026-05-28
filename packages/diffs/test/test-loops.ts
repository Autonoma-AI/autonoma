import { FinishTool } from "@autonoma/ai";
import { z } from "zod";
import type { DiffsAgentResult } from "../src/agents/diffs/diffs-agent";
import { DiffsAgentLoop } from "../src/agents/diffs/diffs-agent-loop";
import { ResolutionAgentLoop } from "../src/agents/resolution/resolution-agent-loop";
import { Codebase } from "../src/codebase";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { ScenarioIndex } from "../src/scenario-index";

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
    existingTests?: ExistingTestInfo[];
    seededAffected?: DiffsAgentResult["affectedTests"];
    validSlugs?: ReadonlySet<string>;
    quarantinedSlugs?: ReadonlySet<string>;
    validConflictSlugs?: ReadonlySet<string>;
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
        seededAffected: overrides.seededAffected ?? [],
        validSlugs: overrides.validSlugs ?? new Set(existingTests.map((t) => t.slug)),
        quarantinedSlugs:
            overrides.quarantinedSlugs ?? new Set(existingTests.filter((t) => t.quarantine != null).map((t) => t.slug)),
        validConflictSlugs: overrides.validConflictSlugs ?? new Set(),
    });
}

export interface ResolutionLoopOverrides {
    workingDirectory?: string;
    flowIndex?: FlowIndex;
    scenarioIndex?: ScenarioIndex;
    existingTests?: ExistingTestInfo[];
    failedSlugs?: ReadonlySet<string>;
    quarantinedSlugs?: ReadonlySet<string>;
}

export function makeResolutionLoop(overrides: ResolutionLoopOverrides = {}): ResolutionAgentLoop {
    const existingTests = overrides.existingTests ?? [];
    return new ResolutionAgentLoop({
        name: "ResolutionAgentTest",
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
        failedSlugs: overrides.failedSlugs ?? new Set(existingTests.map((t) => t.slug)),
        quarantinedSlugs:
            overrides.quarantinedSlugs ?? new Set(existingTests.filter((t) => t.quarantine != null).map((t) => t.slug)),
    });
}
