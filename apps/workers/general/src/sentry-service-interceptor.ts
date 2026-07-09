import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        scenarioUp: "scenario",
        scenarioDown: "scenario",
        reviewGeneration: "generation-reviewer",
        assignGenerationResults: "worker-general",
        notifyGenerationExit: "run-completion-notification",
        markGenerationFailed: "worker-general",
    },
    "worker-general",
);
