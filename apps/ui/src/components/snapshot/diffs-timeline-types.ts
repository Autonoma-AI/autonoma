import type { RouterOutputs } from "lib/trpc";

export type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
export type DiffsJob = NonNullable<SnapshotDetail["diffsJob"]>;
export type DiffsJobStatus = DiffsJob["status"];
export type AffectedTest = DiffsJob["affectedTests"][number];
export type TestCandidate = DiffsJob["testCandidates"][number];
export type SnapshotChange = SnapshotDetail["changes"][number];
export type QuarantinedTest = SnapshotDetail["quarantinedTests"][number];
export type ExecutedTest = SnapshotDetail["executedTests"][number];

export const STAGE_KEYS = ["analysis", "replay", "resolution", "generation", "finalization"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export type StageStatus = "upcoming" | "current" | "done" | "failed";

const ACTIVE_STAGE_OF_STATUS: Partial<Record<DiffsJobStatus, StageKey>> = {
    analyzing: "analysis",
    replaying: "replay",
    resolving: "resolution",
    generating: "generation",
    finalizing: "finalization",
};

function stageEvidence(stage: StageKey, job: DiffsJob): boolean {
    switch (stage) {
        case "analysis":
            return job.analysisReasoning != null || job.affectedTests.length > 0 || job.testCandidates.length > 0;
        case "replay":
            return job.affectedTests.some((t) => t.run != null);
        case "resolution":
            return job.resolutionReasoning != null || job.testCandidates.some((c) => c.status !== "pending");
        case "generation":
            return (
                job.affectedTests.some((t) => t.generation != null) ||
                job.testCandidates.some((c) => c.acceptedTestCase != null)
            );
        case "finalization":
            return false;
    }
}

export function computeStageStatuses(job: DiffsJob): Record<StageKey, StageStatus> {
    if (job.status === "completed") {
        return {
            analysis: "done",
            replay: "done",
            resolution: "done",
            generation: "done",
            finalization: "done",
        };
    }

    if (job.status === "pending") {
        return {
            analysis: "upcoming",
            replay: "upcoming",
            resolution: "upcoming",
            generation: "upcoming",
            finalization: "upcoming",
        };
    }

    if (job.status === "failed") {
        let failedStage: StageKey = "analysis";
        for (const key of STAGE_KEYS) {
            if (stageEvidence(key, job)) failedStage = key;
        }

        const failedIndex = STAGE_KEYS.indexOf(failedStage);
        const result = {} as Record<StageKey, StageStatus>;
        STAGE_KEYS.forEach((key, idx) => {
            if (idx < failedIndex) result[key] = "done";
            else if (idx === failedIndex) result[key] = "failed";
            else result[key] = "upcoming";
        });
        return result;
    }

    const currentStage = ACTIVE_STAGE_OF_STATUS[job.status] ?? "analysis";
    const currentIndex = STAGE_KEYS.indexOf(currentStage);
    const result = {} as Record<StageKey, StageStatus>;
    STAGE_KEYS.forEach((key, idx) => {
        if (idx < currentIndex) result[key] = "done";
        else if (idx === currentIndex) result[key] = "current";
        else result[key] = "upcoming";
    });
    return result;
}
