import type { ModelMessage } from "ai";
import type { ChangeContext, ReviewLineage } from "../kernel";

export interface GenerationStepData {
    order: number;
    interaction: string;
    params: unknown;
    output: unknown;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
}

/**
 * Everything the GenerationReviewer needs to render a prompt and run the
 * agent. Loaded once by the `DiffJobContextLoader`, then passed around as a
 * read-only value object.
 */
export interface GenerationContext {
    generationId: string;
    organizationId: string;
    /** What the execution agent self-reported. The reviewer's verdict overrides this. */
    selfReportedStatus: "success" | "failed" | "running" | "queued" | "pending";
    testPlanPrompt: string;
    conversation: ModelMessage[];
    reasoning?: string;
    videoUrl?: string;
    finalScreenshotKey?: string;
    steps: GenerationStepData[];
    /**
     * DB-sourced facts about the code change under review. Optional so legacy
     * fixtures captured before change context existed still rehydrate; production
     * always populates it via `DiffJobContextLoader` when the snapshot has SHAs.
     */
    change?: ChangeContext;
    /**
     * Point-in-time refinement-loop lineage for this test: the prior verdicts and
     * the plan rewrite history. Absent for first-iteration reviews (no earlier
     * iterations) and for legacy fixtures captured before lineage existed.
     */
    lineage?: ReviewLineage;
}
