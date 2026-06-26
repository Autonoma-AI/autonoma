import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        selectInvestigationTests: "investigation",
        classifyInvestigationRun: "investigation",
        writeInvestigationReport: "investigation",
    },
    "worker-investigation",
);
