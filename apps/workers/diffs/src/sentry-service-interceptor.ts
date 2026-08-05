import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        runImpactAnalysis: "analysis",
        runReporter: "analysis",
        settleAnalysisRun: "analysis",
        openMergeGate: "analysis",
        selfHealAnalysisTest: "analysis",
        revertSelfHealPlan: "analysis",
        deleteAnalysisTest: "analysis",
        persistAnalysisClassification: "analysis",
        classifyInvestigationRun: "investigation",
        reviewGeneration: "generation-reviewer",
    },
    "worker-diffs",
);
