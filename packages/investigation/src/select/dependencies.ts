import type { LanguageModel } from "ai";
import type { CodebaseReader } from "../classify/dependencies";
import type { TestCatalog } from "../db/test-catalog";

/** The capabilities the test-selector needs, injected so the orchestrator is unit-testable. */
export interface SelectorDeps {
    codebase: CodebaseReader;
    catalog: TestCatalog;
    applicationId: string;
    /**
     * Only consider tests created before this time (the PR snapshot's createdAt) - excludes tests the
     * deployed agent created for this same PR, so our selection stays independent for a fair comparison.
     */
    testsCreatedBefore?: Date;
    reasoningModel: LanguageModel;
    maxSteps: number;
}
