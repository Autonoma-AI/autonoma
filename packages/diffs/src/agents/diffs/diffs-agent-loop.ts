import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { TestLookupLoop } from "../tools/lookup/test-lookup-loop";
import type { AffectedTest } from "./affected-test";
import type { DiffsAgentResult } from "./diffs-agent";
import type { TestCandidate } from "./tools/suggest-test-tool";

interface DiffsAgentLoopParams extends AgentConfig<DiffsAgentResult> {
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    /** Affected-test entries seeded before the loop runs (pre-classified merge conflicts). */
    seededAffected: AffectedTest[];
    validSlugs: ReadonlySet<string>;
    quarantinedSlugs: ReadonlySet<string>;
    validConflictSlugs: ReadonlySet<string>;
}

/**
 * Per-run state for the {@link DiffsAgent}. Implements the {@link CodebaseLoop}
 * and {@link TestLookupLoop} capabilities so the shared codebase + lookup tools
 * can read the snapshot's clone, flow tree, and test list directly off the
 * loop. Action tools mutate {@link affectedTests} / {@link testCandidates}
 * directly; the validation sets ({@link validSlugs}, {@link quarantinedSlugs},
 * {@link validConflictSlugs}) are exposed for tools to guard against bad input.
 */
export class DiffsAgentLoop extends AgentLoop<DiffsAgentResult> implements CodebaseLoop, TestLookupLoop {
    public readonly codebase: Codebase;
    public readonly flowIndex: FlowIndex;
    public readonly existingTests: ExistingTestInfo[];

    /** Mutable list of affected tests. Seeded with pre-classified merge conflicts, appended by `mark_affected_test`. */
    public readonly affectedTests: AffectedTest[];
    /** Mutable list of new-test suggestions, appended by `suggest_test`. */
    public readonly testCandidates: TestCandidate[] = [];

    /** Valid slugs - tests that exist in this snapshot. */
    public readonly validSlugs: ReadonlySet<string>;
    /** Slugs of tests quarantined in this snapshot (excluded from replay). */
    public readonly quarantinedSlugs: ReadonlySet<string>;
    /** Slugs of pre-classified merge conflicts the agent must enrich. */
    public readonly validConflictSlugs: ReadonlySet<string>;

    constructor({
        codebase,
        flowIndex,
        existingTests,
        seededAffected,
        validSlugs,
        quarantinedSlugs,
        validConflictSlugs,
        ...config
    }: DiffsAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.flowIndex = flowIndex;
        this.existingTests = existingTests;
        this.affectedTests = [...seededAffected];
        this.validSlugs = validSlugs;
        this.quarantinedSlugs = quarantinedSlugs;
        this.validConflictSlugs = validConflictSlugs;
    }

    protected override snapshotPartial(): { affectedTests: AffectedTest[]; testCandidates: TestCandidate[] } {
        return { affectedTests: [...this.affectedTests], testCandidates: [...this.testCandidates] };
    }
}
