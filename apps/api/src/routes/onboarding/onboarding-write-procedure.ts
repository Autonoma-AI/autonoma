import { z } from "zod";
import { writeProcedure } from "../../trpc";

/**
 * Every onboarding mutation names its application the same way. Read from the
 * raw input because this middleware sits above the per-procedure `.input()`
 * parser - a procedure whose input is shaped differently just reports no
 * application, rather than failing here.
 */
const applicationScopedInput = z.object({ applicationId: z.string().min(1) });

/**
 * `writeProcedure` with onboarding funnel analytics attached.
 *
 * Every onboarding mutation goes through this instead of `writeProcedure`, so
 * the step a user reached, the action that got them there, and the error that
 * stopped them are all recorded without a capture call in any handler - and a
 * mutation added later is instrumented by construction rather than by whoever
 * remembers. See {@link OnboardingAnalytics} for what is emitted.
 *
 * Queries stay on `protectedProcedure`: the onboarding UI polls several of them
 * continuously, and instrumenting reads would bury the funnel in poll traffic.
 */
export const onboardingWriteProcedure = writeProcedure.use(async ({ ctx, next, path, getRawInput }) => {
    const parsed = applicationScopedInput.safeParse(await getRawInput());

    return ctx.services.onboardingAnalytics.trackMutation(
        {
            distinctId: ctx.user.id,
            organizationId: ctx.organizationId,
            applicationId: parsed.success ? parsed.data.applicationId : undefined,
        },
        path,
        () => next(),
    );
});
