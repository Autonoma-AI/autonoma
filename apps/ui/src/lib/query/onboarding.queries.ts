import { type QueryClient, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

/** Fast poll while the agent actively holds the config (the activity stream needs to feel live). */
const AGENT_SESSION_ACTIVE_POLL_MS = 2000;
/** Slow poll while the human holds it: still fast enough to notice the agent taking over, without steady 2s traffic. */
const AGENT_SESSION_IDLE_POLL_MS = 8000;
/** Poll while the linked Vercel project has no READY deployment, so a finishing build appears without a reload. */
const EMPTY_DEPLOYMENTS_POLL_MS = 20_000;
/** Poll while setup is unfinished, so the screen watching it sees the moment it finishes. */
const ONBOARDING_STATE_POLL_MS = 5000;
/**
 * Poll for a config the agent is editing over MCP. Every write comes from the
 * server, so no client mutation ever invalidates this query - without a poll the
 * screen shows whatever the config was when the page loaded. Slower than the
 * activity stream: the config changes a handful of times per session, not per second.
 */
const AGENT_CONFIG_POLL_MS = 5000;

/**
 * Returns an onError handler that, on a backend step-mismatch error
 * ("Cannot X during Y step"), re-runs the route loaders so the refreshed
 * backend state is reflected. Uses `router.invalidate()` rather than a full
 * page reload so React state and the router are preserved. Note: this only
 * refetches - it does not change the URL `step`, since the flow intentionally
 * lets the URL run ahead of the backend in places (e.g. BYO "Continue to
 * verify" sits at `deploy-verify` while the backend is `existing_deploys_waiting`).
 */
function useStepMismatchHandler() {
    const router = useRouter();
    return (error: { message: string }) => {
        const isStepMismatch = error.message.startsWith("Cannot ") && error.message.includes(" during ");
        if (isStepMismatch) void router.invalidate();
    };
}

/**
 * The onboarding state, kept live until setup is finished.
 *
 * The post-go-live steps decide what to show - and when the flow is over - from
 * `setupComplete`, and the work that flips it happens somewhere else entirely: a
 * planner run in a terminal, a coding agent in the repo. Without a poll the field
 * only refreshes when the tab regains focus, so the screen sits on a finished
 * setup until the user happens to click back into it. `refetchIntervalInBackground`
 * for the same reason the agent session polls that way: the user is watching their
 * terminal, and a visible-but-unfocused tab would otherwise stop asking.
 */
export function useOnboardingState(applicationId: string) {
    return useSuspenseQuery(
        trpc.onboarding.getState.queryOptions(
            { applicationId },
            {
                refetchInterval: (query) =>
                    query.state.data?.setupComplete === true ? false : ONBOARDING_STATE_POLL_MS,
                refetchIntervalInBackground: true,
            },
        ),
    );
}

/**
 * The same state, for a caller that may not have an application yet - the onboarding layout,
 * which decides WHICH screen to show.
 *
 * That decision used to read the route loader, which runs once per navigation and never again.
 * So the screen watching a setup could see its own checkmarks go green (those read the polled
 * query) while the value choosing the screen stayed frozen at page load, and the flow never left
 * a step it had finished. Polls on the same terms as {@link useOnboardingState}: the work that
 * finishes setup happens in a terminal, and it stops once `setupComplete` is true.
 */
export function useOnboardingStateOptional(applicationId: string) {
    return useQuery(
        trpc.onboarding.getState.queryOptions(
            { applicationId },
            {
                enabled: applicationId.length > 0,
                refetchInterval: (query) =>
                    query.state.data?.setupComplete === true ? false : ONBOARDING_STATE_POLL_MS,
                refetchIntervalInBackground: true,
            },
        ),
    );
}

// `onboarding.navState` - the one boolean the shell's nav needs, rather than this module's full
// state - is a shell read and lives in `lib/query/app-shell.queries.ts`.

/**
 * Both onboarding reads, invalidated together.
 *
 * `navState` and `getState` are separate cache keys over the same rows, so a mutation that moves one
 * moves the other. Invalidating only the detailed one leaves "Finish setup" in the nav after it is
 * finished, which is exactly the bug the narrow read would otherwise introduce.
 */
export async function invalidateOnboardingState(queryClient: QueryClient, applicationId?: string): Promise<void> {
    const input = applicationId != null ? { applicationId } : undefined;
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.onboarding.getState.queryKey(input) }),
        queryClient.invalidateQueries({ queryKey: trpc.onboarding.navState.queryKey(input) }),
    ]);
}

/** Polls the agentic-onboarding session (control state, pending request, activity stream). */
export function useAgentSession(applicationId: string) {
    return useQuery(
        trpc.onboarding.getAgentSession.queryOptions(
            { applicationId },
            {
                enabled: applicationId.length > 0,
                refetchInterval: (query) =>
                    query.state.data?.effectiveHolder === "agent"
                        ? AGENT_SESSION_ACTIVE_POLL_MS
                        : AGENT_SESSION_IDLE_POLL_MS,
                // The attention cues (tab title, chime, notification) hang off this
                // poll and matter most when the user has tabbed away - without this,
                // React Query pauses the interval in unfocused tabs. Browser timer
                // throttling can still stretch the cadence in long-backgrounded tabs.
                refetchIntervalInBackground: true,
            },
        ),
    );
}

function invalidateAgentSession(queryClient: ReturnType<typeof useQueryClient>) {
    void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getAgentSession.queryKey() });
}

/** Mint the pairing code shown to the user for their coding agent. */
export function useCreateAgentPairing() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.createAgentPairing.mutationOptions({
            onSettled: () => invalidateAgentSession(queryClient),
        }),
    });
}

/** Stop button: the human takes over the config. */
export function useStopAgent() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.stopAgent.mutationOptions({ onSettled: () => invalidateAgentSession(queryClient) }),
    });
}

/** Hand control back to the agent. */
export function useResumeAgent() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.resumeAgent.mutationOptions({ onSettled: () => invalidateAgentSession(queryClient) }),
    });
}

/** Answer an agent env request: set the entered secret values and clear the request. */
export function useSubmitAgentEnv() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.submitAgentEnv.mutationOptions({ onSettled: () => invalidateAgentSession(queryClient) }),
    });
}

export function useConfigureAndDiscoverScenarios() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.configureAndDiscoverScenarios.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.scenarios.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save endpoint configuration" },
    });
}

/** Vercel projects the org can link to this app - excludes projects already linked elsewhere. */
export function useAvailableVercelProjects(applicationId: string) {
    return useQuery(
        trpc.onboarding.listAvailableVercelProjects.queryOptions(
            { applicationId },
            { enabled: applicationId.length > 0 },
        ),
    );
}

export function useLinkVercelProject() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.linkVercelProject.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({
                    queryKey: trpc.onboarding.listAvailableVercelProjects.queryKey(),
                });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getDeploymentSignalStatus.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        successToast: { title: "Vercel project linked" },
        errorToast: { title: "Failed to link Vercel project" },
    });
}

/**
 * Real deployments for the linked Vercel project, used to pick an onboarding
 * preview URL directly. Pass `enabled: false` where no project is linked - the
 * backend rejects that with "No Vercel project linked to this application", and
 * a disabled observer still reads whatever another caller already fetched.
 */
export function useVercelDeployments(applicationId: string, enabled = true) {
    return useQuery(
        trpc.onboarding.listVercelDeployments.queryOptions(
            { applicationId },
            {
                enabled: enabled && applicationId.length > 0,
                // Only READY deployments are listed, so an empty list usually means a
                // build is still running - poll until one lands instead of making the
                // user reload. React Query pauses the interval in unfocused tabs.
                refetchInterval: (query) => (query.state.data?.length === 0 ? EMPTY_DEPLOYMENTS_POLL_MS : false),
            },
        ),
    );
}

/**
 * Redeploys a chosen Vercel deployment so it rebuilds with the injected
 * `AUTONOMA_SHARED_SECRET` (which only takes effect on new builds). Returns the
 * NEW deployment's id/url/state; the caller polls `useVercelDeploymentStatus`
 * and commits with `useSelectVercelDeployment` once it is ready.
 */
export function useRedeployVercelDeployment() {
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.redeployVercelDeployment.mutationOptions({
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to redeploy deployment" },
    });
}

/** Polls a (re)deployed Vercel deployment's build state until it is ready. Disabled until an id is set. */
export function useVercelDeploymentStatus(applicationId: string, vercelDeploymentId: string | undefined) {
    return useQuery(
        trpc.onboarding.getVercelDeploymentStatus.queryOptions(
            { applicationId, vercelDeploymentId: vercelDeploymentId ?? "" },
            {
                enabled: applicationId.length > 0 && vercelDeploymentId != null && vercelDeploymentId.length > 0,
                // Stop polling once the deployment reaches a ready state.
                refetchInterval: (query) => (query.state.data?.ready === true ? false : 5_000),
            },
        ),
    );
}

/** Commits a READY (re)deployed Vercel deployment as the onboarding preview URL - skips the manual CI-signal wait. */
export function useSelectVercelDeployment() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.selectVercelDeployment.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getDeploymentSignalStatus.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        successToast: { title: "Deployment selected" },
        errorToast: { title: "Failed to select deployment" },
    });
}

/**
 * Finish-setup SDK validation for a Vercel app: discovers against the chosen
 * Vercel deployment using the stored shared secret (no manual paste). A
 * secret-drift 401 returns `redeploy_started`; the caller polls the new
 * deployment and auto-retries with `allowRedeploy: false`.
 */
export function useDiscoverVercelDeploymentTarget() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.discoverVercelDeploymentTarget.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.scenarios.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to validate SDK target" },
    });
}

/**
 * Provision the managed target's secrets (auto-run when the SDK step loads). It
 * may kick off a one-time PreviewKit redeploy; the UI tracks readiness off the
 * polled target status, so on settle we refresh the targets + onboarding state.
 */
export function usePrepareSdkTarget() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.prepareSdkTarget.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void invalidateOnboardingState(queryClient);
            },
        }),
        errorToast: { title: "Failed to prepare preview environment" },
    });
}

/**
 * User-triggered (re)deploy of a dry-run target's preview: an existing env
 * redeploys at the latest PR head + config, a PR without one gets its first
 * deploy. The targets poll shows the resulting "building" state.
 */
export function useRedeploySdkDryRunTarget() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.redeploySdkDryRunTarget.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
            },
        }),
        errorToast: { title: "Failed to deploy preview" },
    });
}

export function useConfigureAndDiscoverSdkTarget() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.configureAndDiscoverSdkTarget.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listSdkDryRunTargets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.scenarios.list.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to validate SDK target" },
    });
}

export function useOnboardingScenarios(applicationId: string) {
    return useQuery(trpc.scenarios.list.queryOptions({ applicationId }, { enabled: applicationId.length > 0 }));
}

export function useRunScenarioDryRun() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.runScenarioDryRun.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
            },
        }),
        errorToast: { title: "Scenario dry run failed" },
    });
}

/** Preview envs the SDK dry-run can target (open-PR previews + main, with auto-detect). */
export function useSdkDryRunTargets(applicationId: string) {
    return useSuspenseQuery(
        trpc.onboarding.listSdkDryRunTargets.queryOptions(
            { applicationId },
            {
                refetchInterval: (query) => {
                    const targets = query.state.data?.targets ?? [];
                    const hasBuildingPreviewkitTarget = targets.some(
                        (target) => target.source === "previewkit" && target.availability === "building",
                    );
                    if (targets.length === 0 || hasBuildingPreviewkitTarget) return 5_000;
                    // Slow poll even when everything is ready, so a PR the user just
                    // opened shows up without a manual refresh.
                    return 15_000;
                },
            },
        ),
    );
}

export function useCompleteGithub() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.completeGithub.mutationOptions({
            onSettled: () => void invalidateOnboardingState(queryClient),
        }),
        errorToast: { title: "Failed to complete Github onboarding" },
    });
}

export function useSelectPreviewEnvironmentMode() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.selectPreviewEnvironmentMode.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to select preview environment" },
    });
}

export function useConfirmExistingDeploysSetup() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.confirmExistingDeploysSetup.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to confirm deploy setup" },
    });
}

export function useTriggerPreviewkitMainDeploy() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.triggerPreviewkitMainDeploy.mutationOptions({
            onSettled: () => {
                void invalidateOnboardingState(queryClient);
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to start preview deploy" },
    });
}

/**
 * The application's PreviewKit config document.
 *
 * `poll` is opt-in, and deliberately so. A read-only view of a config an agent is
 * writing over MCP has to poll or it never updates - nothing on the client mutates
 * it, so nothing invalidates it. The editable form and the settings draft read the
 * same query while the user has unsaved changes on screen, and a background refetch
 * there would fight them, so those keep the plain fetch-once behavior.
 */
export function usePreviewkitConfig(applicationId: string, options: { poll?: boolean } = {}) {
    return useSuspenseQuery(
        trpc.onboarding.getPreviewkitConfig.queryOptions(
            { applicationId },
            options.poll === true ? { refetchInterval: AGENT_CONFIG_POLL_MS } : {},
        ),
    );
}

export function useDeployBranches(applicationId: string) {
    return useQuery(trpc.onboarding.listDeployBranches.queryOptions({ applicationId }));
}

export function useSetDeployBranch() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.setDeployBranch.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewkitConfig.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to set deploy branch" },
    });
}

export function useSavePreviewkitConfig() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.savePreviewkitConfig.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewkitConfig.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save preview config" },
    });
}

/**
 * Applies renames before the document write that follows it.
 *
 * Separate from {@link useSavePreviewkitConfig} on purpose: the document save also
 * resolves the primary repository and rejects a retired build preset, and folding
 * the topology write into the operation list would lose both. Two calls cost a
 * round trip; the alternative costs a rename the server cannot see, which deletes
 * the app.
 */
export function useApplyPreviewkitOperations() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.onboarding.applyPreviewkitOperations.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewkitConfig.queryKey() });
            },
        }),
        errorToast: { title: "Failed to rename the app" },
    });
}

export function useDeploymentSignalStatus(applicationId: string) {
    return useQuery(
        trpc.onboarding.getDeploymentSignalStatus.queryOptions(
            { applicationId },
            {
                enabled: applicationId.length > 0,
                // Stop polling once a signal has been accepted (previewUrl present).
                refetchInterval: (query) => {
                    const data = query.state.data;
                    const accepted = data != null && "previewUrl" in data && data.previewUrl != null;
                    return accepted ? false : 5_000;
                },
            },
        ),
    );
}

/** Server-side config validation: schema + semantics + repo-aware preflight, returned as data. */
export function useValidatePreviewkitConfig() {
    return useAPIMutation({
        ...trpc.onboarding.validatePreviewkitConfig.mutationOptions({}),
        errorToast: { title: "Failed to validate preview config" },
    });
}

/**
 * The target repo's Dockerfiles (filtered server-side from the file tree), for
 * the config editor's Dockerfile picker. A best-effort enhancement (not initial
 * page data), so it uses a plain `useQuery` gated on `enabled` - only fetched
 * while the Dockerfile build mode is active. Resolves to `undefined` when GitHub
 * introspection is unavailable, in which case the picker falls back to a
 * free-text path.
 */
export function useDockerfiles(applicationId: string, githubRepositoryId: number | undefined, enabled: boolean) {
    return useQuery(
        trpc.onboarding.listDockerfiles.queryOptions(
            { applicationId, githubRepositoryId },
            { enabled: enabled && applicationId.length > 0, staleTime: 5 * 60 * 1000 },
        ),
    );
}

export function usePreviewkitSecrets(applicationId: string, appName: string) {
    return useSuspenseQuery(trpc.onboarding.listPreviewkitSecrets.queryOptions({ applicationId, appName }));
}

export function usePreviewkitSecretsOptional(applicationId: string, appName: string | undefined) {
    return useQuery(
        trpc.onboarding.listPreviewkitSecrets.queryOptions(
            { applicationId, appName: appName ?? "" },
            { enabled: appName != null && appName.length > 0 },
        ),
    );
}

export function useUpsertPreviewkitSecrets() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.upsertPreviewkitSecrets.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listPreviewkitSecrets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to save preview secret" },
    });
}

export function useDeletePreviewkitSecret() {
    const queryClient = useQueryClient();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.deletePreviewkitSecret.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.listPreviewkitSecrets.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to delete preview secret" },
    });
}

export function usePreviewReadiness(applicationId: string) {
    return useSuspenseQuery(
        trpc.onboarding.getPreviewReadiness.queryOptions(
            { applicationId },
            {
                // Stop polling on a terminal status. A redeploy/edit invalidates
                // this query, which refetches and resumes polling while building.
                refetchInterval: (query) => {
                    const status = query.state.data?.diagnostics.status;
                    return status === "ready" || status === "failed" ? false : 5_000;
                },
            },
        ),
    );
}

export function useCompletePreviewOnboarding() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.completePreviewOnboarding.mutationOptions({
            onSettled: async () => {
                await invalidateOnboardingState(queryClient);
                await queryClient.invalidateQueries({ queryKey: trpc.onboarding.getPreviewReadiness.queryKey() });
                await queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                await router.invalidate();
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to complete preview onboarding" },
    });
}

export function useGoLive() {
    const queryClient = useQueryClient();
    const router = useRouter();
    const onStepMismatch = useStepMismatchHandler();
    return useAPIMutation({
        ...trpc.onboarding.goLive.mutationOptions({
            onSettled: async () => {
                await invalidateOnboardingState(queryClient);
                await queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                await router.invalidate();
            },
            onError: (error) => onStepMismatch(error),
        }),
        errorToast: { title: "Failed to go live" },
    });
}
