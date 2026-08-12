import { SCENARIO_SETUP_FAILURE_TYPE, type SdkFailure, sdkFailureSchema } from "@autonoma/types";
import { ApplicationFailure } from "@temporalio/workflow";

/**
 * Recover the structured {@link SdkFailure} a scenario-provisioning activity carried across the wire, or `undefined`
 * when it carried none. The provisioning activity throws an `ApplicationFailure` of type
 * `SCENARIO_SETUP_FAILURE_TYPE` with the tag as its first `detail`; the workflow observes that below the generic
 * `ActivityFailure` wrapper on the `.cause` chain (the same chain `rootFailureMessage` walks). A non-SDK throw (our
 * orchestration) carries no such failure, so this returns `undefined` and the caller falls back to the message.
 */
export function sdkFailureFromError(error: unknown): SdkFailure | undefined {
    let current: Error | undefined = error instanceof Error ? error : undefined;

    while (current != null) {
        if (current instanceof ApplicationFailure && current.type === SCENARIO_SETUP_FAILURE_TYPE) {
            const parsed = sdkFailureSchema.safeParse(current.details?.[0]);
            return parsed.success ? parsed.data : undefined;
        }
        const cause: unknown = current.cause;
        current = cause instanceof Error ? cause : undefined;
    }

    return undefined;
}
