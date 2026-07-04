import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        selectInvestigationTests: "investigation",
        classifyInvestigationRun: "investigation",
        markInvestigationProgress: "investigation",
        reconcileInvestigationFindings: "investigation",
        writeInvestigationReport: "investigation",
    },
    "worker-investigation",
);
