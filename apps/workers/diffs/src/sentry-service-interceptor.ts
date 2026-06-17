import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        analyzeDiffs: "diffs",
        finalizeDiffs: "diffs",
    },
    "worker-diffs",
);
