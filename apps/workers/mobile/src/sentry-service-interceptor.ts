import { createSentryServiceInterceptor } from "@autonoma/workflow/worker";

export const sentryServiceInterceptor = createSentryServiceInterceptor(
    {
        runMobileGeneration: "engine-mobile",
    },
    "worker-mobile",
);
