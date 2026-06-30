import type { LanguageModel } from "ai";
import type { CodebaseReader } from "../classify/dependencies";
import type { TestCatalog } from "../db/test-catalog";

/** The capabilities the test-selector needs, injected so the orchestrator is unit-testable. */
export interface SelectorDeps {
    codebase: CodebaseReader;
    catalog: TestCatalog;
    /**
     * The investigation snapshot under analysis. Selection is scoped to the tests assigned to it (the branch's
     * frozen baseline suite), and each test runs from the plan that snapshot pinned - never a latest-plan lookup.
     */
    snapshotId: string;
    reasoningModel: LanguageModel;
    maxSteps: number;
}
