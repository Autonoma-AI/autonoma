import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        analyzeDiffs: "diffs",
        resolveDiffs: "diffs",
        finalizeDiffs: "diffs",
    },
    "worker-diffs",
);
