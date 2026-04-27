import * as Sentry from "@sentry/node";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";

export function createSentryServiceInterceptor(
    serviceMap: Record<string, string>,
    fallbackService: string,
): ActivityInterceptorsFactory {
    return (ctx) => {
        const activityType = ctx.info.activityType;
        const service = serviceMap[activityType] ?? fallbackService;

        const tags: Record<string, string> = {
            service,
            activity: activityType,
            workflow_id: ctx.info.workflowExecution.workflowId,
            workflow_run_id: ctx.info.workflowExecution.runId,
        };

        return {
            inbound: {
                async execute(input, next) {
                    return Sentry.withIsolationScope(async (isolationScope) => {
                        for (const [k, v] of Object.entries(tags)) isolationScope.setTag(k, v);

                        // Also fork and set tags on current scope; Sentry merges
                        // global → isolation → current with later winning, so any
                        // tag set on the outer current scope (e.g. from initialScope
                        // in runWithSentry) would otherwise override our isolation
                        // scope tags.
                        return Sentry.withScope((currentScope) => {
                            for (const [k, v] of Object.entries(tags)) currentScope.setTag(k, v);
                            return next(input);
                        });
                    });
                },
            },
        };
    };
}
