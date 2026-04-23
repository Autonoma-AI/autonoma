/**
 * Re-exports from the real tRPC-backed query hooks.
 * All onboarding API interactions go through lib/query/onboarding.queries.ts.
 */
export {
    useOnboardingState,
    usePollAgentLogs,
    useResetOnboarding,
    useStartConfigure,
    useStartScenarioDryRun,
    useSetUrl,
    useConfigureAndDiscoverScenarios,
    useOnboardingScenarios,
    useOnboardingStateOptional,
    useRunScenarioDryRun,
    useCompleteOnboarding,
    useCompleteGithub,
} from "lib/query/onboarding.queries";
