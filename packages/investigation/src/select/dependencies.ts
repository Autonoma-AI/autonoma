import type { LanguageModel } from "ai";
import type { CodebaseReader } from "../classify/dependencies";
import type { TestCatalog } from "../db/test-catalog";

/** The capabilities the test-selector needs, injected so the orchestrator is unit-testable. */
export interface SelectorDeps {
    codebase: CodebaseReader;
    catalog: TestCatalog;
    /**
     * The investigation snapshot under analysis. Selection is scoped to the tests assigned to it, and each test
     * runs from the plan that snapshot pinned - never a latest-plan lookup.
     */
    snapshotId: string;
    /**
     * Base-relative cutoff for the candidate catalog: the snapshot's own createdAt. Tests created at/after it are
     * dropped so the selector sees the genuine pre-PR suite, not the diffs agent's same-PR test creations that
     * get assigned onto the twin after the fork. Omit to consider every assigned test (unit tests).
     */
    testsCreatedBefore?: Date;
    reasoningModel: LanguageModel;
    maxSteps: number;
}
